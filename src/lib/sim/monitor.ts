import { Creature } from './creature.ts';
import { cellDoorAt, dropTarget, placeActor, type DropTarget } from './agentDrag.ts';
import { ACHIEVEMENTS, FacilityEventDirector } from './facilityEvents.ts';
import { bindDebugPanel } from './monitorDebug.ts';
import { bindMonitorDiagnostics, diagnosticError, type MonitorDiagnostics } from './monitorDiagnostics.ts';
import { clock, el, EventListeners } from './monitorDom.ts';
import { EditorPanel } from './monitorEditor.ts';
import { MonitorFile } from './monitorFile.ts';
import { followCameraRoom } from './monitorFollow.ts';
import { IncidentFeed } from './monitorIncidents.ts';
import { loadProgress, saveProgress } from './monitorProgress.ts';
import { NameTags } from './monitorTags.ts';
import { VitalsHud } from './monitorVitals.ts';
import { PropEditor } from './propEditor.ts';
import { PropEmissionSampler, PropPicker, Renderer, loadAssets } from './render.ts';
import type { Remains } from './remains.ts';
import type { SimCharacter, SimCreature, SimImpostor } from './roster.ts';
import { Room, type Point, type RoomData } from './room.ts';
import { World, type CameraActor, type LogTone } from './world.ts';

export interface MonitorConfig {
  roster: SimCharacter[];
  creatureRoster: SimCreature[];
  impostors: SimImpostor[];
  /** Every room on camera, in floor-plan order. */
  rooms: RoomData[];
  /** Room shown when nobody has picked a camera yet. */
  initialRoom: string;
  /** Image URLs by name: room, actor and prop sheets, "item:<type>", and "particle:<file>". */
  assets: Record<string, string>;
}

const MAX_LOG_LINES = 40;
const SWITCH_STATIC_MS = 220;
const DRAG_CAMERA_HOVER_MS = 450;
const TOAST_MS = 4000;
const DRAG_START_PX = 5;
const DEBUG_FAST_SPEED = 4;

/** Boots the live feed inside `root`. Returns a cleanup function. */
export function initMonitor(root: HTMLElement): () => void {
  const configNode = root.querySelector<HTMLScriptElement>('[data-monitor-config]');
  const canvas = root.querySelector<HTMLCanvasElement>('[data-monitor-canvas]');
  const tagLayer = root.querySelector<HTMLElement>('[data-monitor-tags]');
  if (!configNode || !canvas || !tagLayer) return () => {};
  // Page scripts can be re-run after client-side navigation; never boot twice on one page.
  if (root.dataset.monitorActive) return () => {};
  root.dataset.monitorActive = 'true';

  const debugMode = new URLSearchParams(location.search).has('debug');
  const diagnosticPanel = bindMonitorDiagnostics(root, debugMode);
  try {
    const cleanup = bootMonitor(root, configNode, canvas, tagLayer, diagnosticPanel.diagnostics, diagnosticPanel.notify, debugMode);
    return () => {
      cleanup();
      diagnosticPanel.dispose();
    };
  } catch (error) {
    diagnosticPanel.diagnostics.record('boot-error', diagnosticError(error));
    diagnosticPanel.diagnostics.persist();
    diagnosticPanel.notify('Simulation startup failed. Copy diagnostics to investigate.');
    console.error('Simulation startup failed', error);
    return () => {
      delete root.dataset.monitorActive;
      diagnosticPanel.dispose();
    };
  }
}

function bootMonitor(
  root: HTMLElement, configNode: HTMLScriptElement, canvas: HTMLCanvasElement, tagLayer: HTMLElement,
  diagnostics: MonitorDiagnostics, notifyDiagnostics: (message: string) => void, debugMode: boolean,
): () => void {
  const config: MonitorConfig = JSON.parse(configNode.textContent ?? '{}');
  const status = root.querySelector<HTMLElement>('[data-monitor-status]');
  const clockNode = root.querySelector<HTMLElement>('[data-monitor-clock]');
  const alertNode = root.querySelector<HTMLElement>('[data-monitor-alert]');
  const fileNode = root.querySelector<HTMLElement>('[data-monitor-file]');
  const vitalsNode = root.querySelector<HTMLElement>('[data-monitor-vitals]');
  const logNode = root.querySelector<HTMLOListElement>('[data-monitor-log]');
  const incidentNode = root.querySelector<HTMLOListElement>('[data-monitor-incidents]');
  const achievementList = root.querySelector<HTMLUListElement>('[data-monitor-achievements]');
  const achievementCount = root.querySelector<HTMLElement>('[data-monitor-achievement-count]');
  const rosterCount = root.querySelector<HTMLElement>('[data-monitor-roster-count]');
  const toast = root.querySelector<HTMLElement>('[data-monitor-toast]');
  const tagsToggle = root.querySelector<HTMLButtonElement>('[data-monitor-toggle-tags]');
  const pauseToggle = root.querySelector<HTMLButtonElement>('[data-monitor-toggle-pause]');
  const followToggle = root.querySelector<HTMLButtonElement>('[data-monitor-toggle-follow]');
  const followStatus = root.querySelector<HTMLElement>('[data-monitor-follow-status]');
  const debugPanel = root.querySelector<HTMLElement>('[data-monitor-debug]');
  const screen = root.querySelector<HTMLElement>('[data-monitor-screen]');
  const stage = root.querySelector<HTMLElement>('[data-monitor-stage]');
  const dragStatus = root.querySelector<HTMLElement>('[data-monitor-drag-status]');
  const dragHelp = dragStatus?.textContent?.trim() ?? '';
  const carry = root.querySelector<HTMLElement>('[data-monitor-carry]');
  const inputSurface = stage ?? canvas;
  const listeners = new EventListeners();
  const camTitle = root.querySelector<HTMLElement>('[data-monitor-cam-title]');
  const cameraButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-monitor-camera]')];
  const levelButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-monitor-level]')];
  const levelRows = [...root.querySelectorAll<HTMLElement>('[data-monitor-level-row]')];

  const rooms = config.rooms.map((data) => new Room(data));
  // Milliseconds added to the real clock by the debug time override (0 = live).
  let clockOffset = 0;
  const world = new World({ roster: config.roster, creatureRoster: config.creatureRoster, rooms, now: () => new Date(Date.now() + clockOffset) });
  const director = new FacilityEventDirector(config.impostors);
  const progress = loadProgress();
  const unlocked = new Set(progress.achievements);
  const identified = new Set(progress.identified);
  const camerasSeen = new Set(progress.cameras);
  const maxRoomWidth = Math.max(...rooms.map((room) => room.width));
  let viewed = world.room(progress.camera ?? '') ?? world.room(config.initialRoom) ?? rooms[0];
  let refreshDebugEvents: (() => void) | undefined;

  let disposed = false;
  let raf = 0;
  let paused = false;
  let speed = 1;
  let showAllTags = true;
  let hovered: CameraActor | null = null;
  let hoveredRemains: Remains | null = null;
  let selected: CameraActor | null = null;
  let followed: CameraActor | null = null;
  let renderer: Renderer | null = null;
  let propPicker: PropPicker | null = null;
  let drag: {
    agent: CameraActor; pointerId: number; start: Point; client: Point; offset: Point;
    point: Point; head: Point; origin: Room; active: boolean;
  } | null = null;
  let dragCameraHover: HTMLButtonElement | null = null;
  let dragCameraTimer = 0;
  let dragSwitchPoint: Point | null = null;
  let suppressClick = false;
  let suppressDoubleClick = false;
  let toastTimer = 0;

  const snapshot = () => ({
    camera: viewed.id, paused, speed, clockOffset, simulationTime: world.time,
    simulationClock: world.now().toISOString(), visibility: document.visibilityState,
    selected: selected?.character.id ?? null, followed: followed?.character.id ?? null,
    held: drag?.active ? (drag.agent instanceof Creature ? drag.agent.character.id : drag.agent.uid) : null,
    counts: { rooms: rooms.length, agents: world.agents.length, creatures: world.creatures.length },
    events: world.events.activeEvents,
    agents: world.agents.slice(0, 100).map((agent) => ({
      uid: agent.uid, id: agent.character.id, room: agent.room.id,
      x: agent.x, y: agent.y, activity: agent.activity, moving: agent.moving,
      leaving: agent.leaving, held: agent.held, impostor: agent.impostor?.id ?? null,
    })),
    creatures: world.creatures.slice(0, 100).map((creature) => ({
      id: creature.character.id, room: creature.room.id, home: creature.home.id,
      x: creature.x, y: creature.y, activity: creature.activity,
    })),
    floors: [...new Set(rooms.map((room) => room.level))].map((number) => ({
      number, events: world.level(number)?.activeEvents,
    })),
  });

  // --- Log & achievements -------------------------------------------------

  const log = (text: string, tone: LogTone = 'default') => {
    diagnostics.record(`incident:${tone}`, text);
    if (!logNode) return;
    const item = el('li', `monitor-log-line is-${tone}`);
    item.append(el('time', 'monitor-log-time', clock(world.now())), document.createTextNode(text));
    logNode.prepend(item);
    while (logNode.children.length > MAX_LOG_LINES) logNode.lastElementChild?.remove();
  };

  const renderAchievements = () => {
    if (achievementList) {
      achievementList.replaceChildren(...ACHIEVEMENTS.map((achievement) => {
        const done = unlocked.has(achievement.id);
        const item = el('li', `monitor-achievement${done ? ' is-unlocked' : ''}`);
        item.append(
          el('span', 'monitor-achievement-mark', done ? '■' : '□'),
          el('strong', 'monitor-achievement-title', achievement.title),
          el('span', 'monitor-achievement-desc', achievement.description),
        );
        return item;
      }));
    }
    if (achievementCount) achievementCount.textContent = `${unlocked.size}/${ACHIEVEMENTS.length}`;
    if (rosterCount) {
      const known = config.roster.filter((character) => identified.has(character.id)).length;
      rosterCount.textContent = `${known}/${config.roster.length}`;
    }
  };

  const achieve = (id: string, room?: Room) => {
    const achievement = ACHIEVEMENTS.find((item) => item.id === id);
    // Some achievements only count when they happen on the camera being watched.
    if (!achievement || unlocked.has(id) || (room && room !== viewed)) return;
    unlocked.add(id);
    progress.achievements = [...unlocked];
    saveProgress(progress);
    renderAchievements();
    log(`Achievement complete: ${achievement.title}`, 'ok');
    if (toast) {
      toast.textContent = `Achievement complete: ${achievement.title}`;
      toast.hidden = false;
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => { toast.hidden = true; }, TOAST_MS);
    }
  };

  // --- Cameras -------------------------------------------------------------

  let staticTimer = 0;
  const lastRoomOnLevel = new Map<number, Room>();

  const updateFollowControls = () => {
    if (followToggle) {
      followToggle.disabled = !followed && (!selected ||
        ((selected instanceof Creature ? selected.consumed : selected.removed) && !world.vore.consumed.has(selected.character.id)));
      const label = followed ? 'Stop following' : 'Follow selected';
      if (followToggle.textContent !== label) followToggle.textContent = label;
      const pressed = String(!!followed);
      if (followToggle.getAttribute('aria-pressed') !== pressed) followToggle.setAttribute('aria-pressed', pressed);
    }
    if (followStatus) {
      const text = followed
        ? `Following ${followed.character.name}${followCameraRoom(world, followed) ? '' : ' (off camera)'}`
        : '';
      if (followStatus.textContent !== text) followStatus.textContent = text;
    }
  };

  const stopFollowing = () => {
    followed = null;
    updateFollowControls();
  };

  const toggleFollowing = (actor: CameraActor) => {
    followed = followed === actor ? null : actor;
    updateFollowControls();
  };

  const switchCamera = (room: Room) => {
    const changed = room !== viewed;
    if (changed) diagnostics.record('camera', `${viewed.id} -> ${room.id}`);
    if (changed && !drag?.active) cancelDrag();
    viewed = room;
    refreshDebugEvents?.();
    // Same pixel scale on every camera, so characters don't change size between rooms.
    if (stage) stage.style.width = `${(room.width / maxRoomWidth) * 100}%`;
    canvas.style.aspectRatio = `${room.width} / ${room.height}`;
    if (changed) {
      hovered = null;
      hoveredRemains = null;
      renderer?.setRoom(room);
      editorPanel.editor?.setRoom(room);
      if (screen) {
        // A burst of static, like a real CCTV feed changing channel.
        screen.classList.remove('is-switching');
        void screen.offsetWidth;
        screen.classList.add('is-switching');
        window.clearTimeout(staticTimer);
        staticTimer = window.setTimeout(() => screen.classList.remove('is-switching'), SWITCH_STATIC_MS);
      }
    }
    canvas.setAttribute('aria-label', `Live camera feed of the ${room.label} ${room.name}. Use the name tags to inspect personnel and entities.`);
    if (camTitle) camTitle.textContent = `${room.camera} · ${room.label} · ${room.name}`;
    for (const button of cameraButtons) {
      const active = button.dataset.monitorCamera === room.id;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    // Show this floor's row of cameras.
    lastRoomOnLevel.set(room.level, room);
    for (const row of levelRows) row.hidden = Number(row.dataset.monitorLevelRow) !== room.level;
    for (const button of levelButtons) {
      const active = Number(button.dataset.monitorLevel) === room.level;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }

    progress.camera = room.id;
    camerasSeen.add(room.id);
    progress.cameras = [...camerasSeen];
    saveProgress(progress);
    if (rooms.every((other) => camerasSeen.has(other.id))) achieve('channel-surfer');
    if (changed && drag?.active) {
      clearDragCameraHover();
      // A new layout can move floor buttons under a stationary pointer.
      dragSwitchPoint = { ...drag.client };
    }
  };

  const onCameraClick = (event: MouseEvent) => {
    const id = (event.currentTarget as HTMLElement).dataset.monitorCamera;
    const room = id && world.room(id);
    if (room) {
      stopFollowing();
      switchCamera(room);
    }
  };
  for (const button of cameraButtons) listeners.listen(button, 'click', onCameraClick);

  // Changing floor shows the camera last watched there, else the one on the same elevator shaft
  // as the current camera (so "down" from the Offices lands in the room below), else the first one.
  const cameraOnLevel = (level: number) => {
    if (level === viewed.level) return viewed;
    const sameShaft = world.elevatorStops(viewed).find((room) => room.level === level);
    return lastRoomOnLevel.get(level) ?? sameShaft ?? rooms.find((room) => room.level === level);
  };
  const onLevelClick = (event: MouseEvent) => {
    const target = cameraOnLevel(Number((event.currentTarget as HTMLElement).dataset.monitorLevel));
    if (target) {
      stopFollowing();
      switchCamera(target);
    }
  };
  for (const button of levelButtons) listeners.listen(button, 'click', onLevelClick);

  const updateCameraCounts = () => {
    for (const button of cameraButtons) {
      const room = world.room(button.dataset.monitorCamera ?? '');
      const count = button.querySelector('[data-monitor-camera-count]');
      if (room && count) count.textContent = String(world.actorsIn(room).length);
    }
    for (const button of levelButtons) {
      const level = Number(button.dataset.monitorLevel);
      const count = button.querySelector('[data-monitor-level-count]');
      if (count) count.textContent = String(world.agents.filter((agent) => agent.room.level === level).length +
        world.creatures.filter((creature) => creature.onCamera && creature.room.level === level).length);
    }
  };

  // --- Personnel file & selection ---------------------------------------

  const file = fileNode ? new MonitorFile(fileNode, world, (room) => {
    stopFollowing();
    switchCamera(room);
  }) : null;
  const vitals = vitalsNode ? new VitalsHud(vitalsNode, world) : null;

  const incidents = incidentNode ? new IncidentFeed(
    incidentNode,
    root.querySelector<HTMLElement>('[data-monitor-incidents-empty]'),
    root.querySelector<HTMLElement>('[data-monitor-incident-count]'),
    world.incidents, listeners,
    (room) => {
      stopFollowing();
      switchCamera(room);
    },
  ) : null;

  const select = (agent: CameraActor) => {
    selected = agent;
    updateFollowControls();
    if (agent instanceof Creature) return;
    if (!agent.removed) world.interact(agent);
    if (!agent.character.href) return;
    if (!agent.impostor) {
      identified.add(agent.character.id);
      progress.identified = [...identified];
      saveProgress(progress);
      renderAchievements();
      if (config.roster.every((character) => identified.has(character.id))) achieve('full-roster');
    }
    achieve('first-contact');
  };

  // --- Name tags -----------------------------------------------------------

  const tags = new NameTags(tagLayer, {
    select,
    hover: (agent) => { hovered = agent; },
    hovered: () => hovered,
  });

  // --- Input ---------------------------------------------------------------

  const toRoom = (event: { clientX: number; clientY: number }) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * viewed.width,
      y: ((event.clientY - rect.top) / rect.height) * viewed.height,
    };
  };

  const actorAt = (event: { clientX: number; clientY: number }, point: Point) => {
    return tags.actorFor(document.elementFromPoint(event.clientX, event.clientY))
      ?? renderer?.hitTest(world, point.x, point.y) ?? null;
  };

  const currentDrop = (): DropTarget => {
    if (!drag) return { kind: 'invalid', label: 'Nobody picked up' };
    const event = { clientX: drag.client.x, clientY: drag.client.y };
    const pointer = toRoom(event);
    if (pointer.x < 0 || pointer.y < 0 || pointer.x >= viewed.width || pointer.y >= viewed.height) {
      return { kind: 'invalid', label: 'Drop inside the camera feed' };
    }
    const partner = actorAt(event, pointer);
    const prop = partner ? null : propPicker?.at(viewed, pointer, world.time);
    const door = partner || prop ? undefined : cellDoorAt(world, viewed, pointer);
    return dropTarget(world, drag.agent, partner || prop || door ? pointer : drag.point, partner, prop, viewed, door);
  };

  const setDragStatus = (text: string) => {
    if (dragStatus && dragStatus.textContent !== text) dragStatus.textContent = text;
  };

  const clearDragCameraHover = () => {
    window.clearTimeout(dragCameraTimer);
    dragCameraHover?.classList.remove('is-drag-hover');
    dragCameraHover = null;
  };

  const updateDragCameraHover = (): string | null => {
    if (!drag?.active) return null;
    if (dragSwitchPoint && Math.hypot(drag.client.x - dragSwitchPoint.x, drag.client.y - dragSwitchPoint.y) >= DRAG_START_PX) {
      dragSwitchPoint = null;
    }
    const element = document.elementFromPoint(drag.client.x, drag.client.y);
    const button = element?.closest<HTMLButtonElement>('[data-monitor-camera], [data-monitor-level]');
    const room = button && root.contains(button)
      ? button.dataset.monitorCamera
        ? world.room(button.dataset.monitorCamera)
        : cameraOnLevel(Number(button.dataset.monitorLevel))
      : undefined;
    if (!button || !room) {
      clearDragCameraHover();
      return null;
    }
    if (room === viewed || dragSwitchPoint) {
      clearDragCameraHover();
      return `Move into the feed to drop in ${viewed.name} (${viewed.label})`;
    }
    if (dragCameraHover !== button) {
      clearDragCameraHover();
      dragCameraHover = button;
      button.classList.add('is-drag-hover');
      dragCameraTimer = window.setTimeout(() => {
        if (!drag?.active) return;
        const current = document.elementFromPoint(drag.client.x, drag.client.y)
          ?.closest('[data-monitor-camera], [data-monitor-level]');
        if (current !== button) {
          clearDragCameraHover();
          return;
        }
        switchCamera(room);
      }, DRAG_CAMERA_HOVER_MS);
    }
    return `Hold to switch to ${room.name} (${room.label})`;
  };

  const cancelDrag = () => {
    if (!drag) return;
    const { agent, pointerId } = drag;
    agent.held = false;
    drag = null;
    clearDragCameraHover();
    dragSwitchPoint = null;
    suppressClick = true;
    if (inputSurface.hasPointerCapture(pointerId)) inputSurface.releasePointerCapture(pointerId);
    root.classList.remove('is-dragging');
    canvas.style.cursor = '';
    if (carry) carry.hidden = true;
    setDragStatus(dragHelp);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!renderer) return;
    const point = toRoom(event);
    const editor = editorPanel.editor;
    if (editor?.active) {
      editor.pointerMove(point);
      if (editor.cursor) editorPanel.showCursor(editor.cursor);
      return;
    }
    if (drag && event.pointerId === drag.pointerId) {
      drag.client = { x: event.clientX, y: event.clientY };
      if (!drag.active && Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y) >= DRAG_START_PX) {
        if (!drag.agent.draggable) {
          log(`${drag.agent.character.name} cannot be picked up during this activity.`, 'warn');
          cancelDrag();
          suppressClick = true;
          return;
        }
        drag.active = true;
        suppressDoubleClick = true;
        drag.agent.held = true;
        drag.head = renderer.headPosition(drag.agent);
        root.classList.add('is-dragging');
      }
      if (drag.active) {
        event.preventDefault();
        drag.point = { x: point.x - drag.offset.x, y: point.y - drag.offset.y };
        const target = currentDrop();
        hovered = target.kind === 'agent' ? target.partner : null;
        canvas.style.cursor = target.kind === 'invalid' ? 'not-allowed' : 'grabbing';
        setDragStatus(`${drag.agent.character.name}: ${updateDragCameraHover() ?? target.label}`);
      }
      return;
    }
    hovered = renderer.hitTest(world, point.x, point.y);
    hoveredRemains = hovered ? null : renderer.remainsAt(point.x, point.y);
    canvas.style.cursor = hovered ? (hovered.draggable ? 'grab' : 'pointer')
      : hoveredRemains ? 'pointer' : '';
  };
  const onPointerLeave = () => {
    if (drag) return;
    hovered = null;
    hoveredRemains = null;
    canvas.style.cursor = '';
    editorPanel.editor?.pointerLeave();
    editorPanel.showCursor(null);
  };
  const onClick = (event: MouseEvent) => {
    if (suppressClick && event.detail !== 0) {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    suppressClick = false;
    if (!renderer || editorPanel.active) return;
    if (event.target instanceof Element && event.target.closest('.monitor-tag')) return;
    const point = toRoom(event);
    // Remains on the floor pull up the file of whoever they were.
    const agent = renderer.hitTest(world, point.x, point.y) ?? renderer.remainsAt(point.x, point.y)?.actor;
    if (agent) select(agent);
  };
  const onDoubleClick = (event: MouseEvent) => {
    if (suppressDoubleClick) {
      suppressDoubleClick = false;
      return;
    }
    if (!renderer || editorPanel.active || drag?.active) return;
    const actor = actorAt(event, toRoom(event));
    if (actor) {
      event.preventDefault();
      toggleFollowing(actor);
    }
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!renderer || event.button !== 0 || !event.isPrimary || drag) return;
    if (event.detail <= 1) suppressDoubleClick = false;
    suppressClick = false;
    if (editorPanel.editor?.active) {
      inputSurface.setPointerCapture(event.pointerId);
      editorPanel.editor.pointerDown(toRoom(event), world.time);
      return;
    }
    const point = toRoom(event);
    const agent = actorAt(event, point);
    if (!agent) return;
    drag = {
      agent, pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY },
      client: { x: event.clientX, y: event.clientY },
      offset: { x: point.x - agent.x, y: point.y - agent.y }, point: { x: agent.x, y: agent.y },
      head: renderer.headPosition(agent), origin: agent.room, active: false,
    };
    inputSurface.setPointerCapture(event.pointerId);
  };
  const onPointerUp = (event: PointerEvent) => {
    if (editorPanel.editor?.active) {
      editorPanel.editor.pointerUp();
      if (inputSurface.hasPointerCapture(event.pointerId)) inputSurface.releasePointerCapture(event.pointerId);
      return;
    }
    if (!drag || drag.pointerId !== event.pointerId) return;
    const { agent, active } = drag;
    if (active) {
      drag.client = { x: event.clientX, y: event.clientY };
      const point = toRoom(event);
      drag.point = { x: point.x - drag.offset.x, y: point.y - drag.offset.y };
      const target = currentDrop();
      agent.held = false;
      placeActor(world, agent, target);
      updateCameraCounts();
    }
    cancelDrag();
    if (!active) {
      // Capture retargets tag clicks to the stage; keep ordinary selection working.
      select(agent);
      suppressClick = true;
    }
  };
  const onPointerCancel = () => {
    cancelDrag();
    editorPanel.editor?.pointerUp();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (event.key === 'Escape' && drag) {
      event.preventDefault();
      cancelDrag();
      return;
    }
    const editor = editorPanel.editor;
    if (event.key === 'Escape' && followed && !editor?.active) {
      event.preventDefault();
      stopFollowing();
      return;
    }
    if (event.key === 'Escape' && selected && !editor?.active && !target?.closest('input, textarea, select')) {
      event.preventDefault();
      selected = null;
      updateFollowControls();
      return;
    }
    if (!editor?.active || target?.closest('input, textarea')) return;
    if (editor.key(event)) event.preventDefault();
  };
  listeners.listen(inputSurface, 'pointermove', onPointerMove);
  listeners.listen(inputSurface, 'pointerleave', onPointerLeave);
  listeners.listen(inputSurface, 'click', onClick, true);
  listeners.listen(inputSurface, 'dblclick', onDoubleClick);
  listeners.listen(inputSurface, 'pointerdown', onPointerDown);
  listeners.listen(inputSurface, 'pointerup', onPointerUp);
  listeners.listen(inputSurface, 'pointercancel', onPointerCancel);
  listeners.listen(inputSurface, 'lostpointercapture', onPointerCancel);
  listeners.listen(window, 'blur', onPointerCancel);
  listeners.listen(window, 'keydown', onKeyDown);

  if (followToggle) listeners.listen(followToggle, 'click', () => {
    if (followed) stopFollowing();
    else if (selected) toggleFollowing(selected);
  });
  if (tagsToggle) listeners.listen(tagsToggle, 'click', () => {
    showAllTags = !showAllTags;
    tagsToggle.setAttribute('aria-pressed', String(showAllTags));
    tagsToggle.textContent = showAllTags ? 'Name tags: On' : 'Name tags: Hover';
  });
  if (pauseToggle) listeners.listen(pauseToggle, 'click', () => {
    paused = !paused;
    diagnostics.record('pause', String(paused));
    pauseToggle.setAttribute('aria-pressed', String(paused));
    pauseToggle.textContent = paused ? 'Resume feed' : 'Pause feed';
    root.classList.toggle('is-paused', paused);
  });

  // --- Debug tools (?debug) ----------------------------------------------

  const editorPanel = new EditorPanel(root.querySelector<HTMLElement>('[data-monitor-editor]'), root);
  const toggleEditor = () => {
    if (!editorPanel.editor) return;
    cancelDrag();
    const active = editorPanel.toggle();
    if (active) stopFollowing();
    root.classList.toggle('is-editing', active);
    debugPanel?.querySelector('[data-debug="props"]')?.setAttribute('aria-pressed', String(active));
    hovered = null;
    hoveredRemains = null;
  };

  if (debugPanel && debugMode) {
    refreshDebugEvents = bindDebugPanel(debugPanel, {
      world,
      director,
      log,
      onCamera: () => world.agentsIn(viewed),
      selected: () => selected,
      currentRoom: () => viewed,
      setClockOffset: (ms) => { clockOffset = ms; },
      refreshClock: () => tick(),
      toggleSpeed: () => {
        speed = speed === 1 ? DEBUG_FAST_SPEED : 1;
        log(`Debug: speed x${speed}.`, 'muted');
      },
      toggleEditor,
      resetProgress: () => {
        unlocked.clear();
        identified.clear();
        camerasSeen.clear();
        camerasSeen.add(viewed.id);
        progress.achievements = [];
        progress.identified = [];
        progress.cameras = [...camerasSeen];
        saveProgress(progress);
        renderAchievements();
      },
    }, listeners);
  }

  // --- Clock & status ------------------------------------------------------

  const tick = () => {
    const now = world.now();
    if (clockNode) clockNode.textContent = clock(now, true);
    if (!clockOffset && now.getHours() < 5) achieve('night-shift');
    if (alertNode) {
      const incident = incidents?.status;
      const duplicate = world.everyone().some((agent) => agent.impostor && !agent.revealed);
      const eventAlerts = [
        ...world.events.activeAlerts,
        ...(world.level(viewed.level)?.activeAlerts ?? []),
      ];
      const alerts = [
        ...(incident ? [{ text: incident, priority: 100 }] : []),
        ...(duplicate ? [{ text: 'Duplicate badge', priority: 50 }] : []),
        ...eventAlerts,
      ];
      const activeAlert = alerts.reduce<(typeof alerts)[number] | undefined>(
        (highest, alert) => !highest || alert.priority > highest.priority ? alert : highest,
        undefined,
      );
      alertNode.textContent = activeAlert?.text ?? 'All clear';
      alertNode.classList.toggle('is-alert', !!activeAlert);
    }
    updateCameraCounts();
  };
  tick();
  const clockTimer = window.setInterval(tick, 1000);

  // --- Boot ----------------------------------------------------------------

  world.hooks = {
    log,
    achieve,
    removed: (agent) => {
      if (drag?.agent === agent) cancelDrag();
      if (hovered === agent) hovered = null;
      if (followed === agent && !world.vore.consumed.has(agent.character.id)) stopFollowing();
      else if (selected === agent) updateFollowControls();
    },
  };
  renderAchievements();
  file?.render(null, viewed);
  switchCamera(viewed);

  const resizeObserver = new ResizeObserver(() => renderer?.resize());
  resizeObserver.observe(canvas);

  let last = performance.now();
  let lastFrameCompleted = last;
  let stalled = false;
  let failed = false;
  const fail = (error: unknown) => {
    failed = true;
    diagnostics.record('simulation-error', diagnosticError(error));
    diagnostics.checkpoint(snapshot, true);
    notifyDiagnostics('Simulation stopped with an error. Copy diagnostics to investigate.');
    console.error('Simulation stopped', error);
    if (status) {
      status.hidden = false;
      status.textContent = debugMode
        ? 'Feed stopped: copy diagnostics below'
        : 'Feed stopped: reopen this page with ?debug for diagnostics';
    }
  };
  const onVisibility = () => {
    last = performance.now();
    lastFrameCompleted = last;
    stalled = false;
  };
  listeners.listen(document, 'visibilitychange', onVisibility);
  const watchdogTimer = window.setInterval(() => {
    if (disposed || failed || !renderer || document.hidden || stalled) return;
    if (performance.now() - lastFrameCompleted > 5000) {
      stalled = true;
      diagnostics.record('frame-stall', 'No completed animation frame for over 5 seconds while visible.');
      diagnostics.checkpoint(snapshot, true);
      notifyDiagnostics('The camera frame loop appears stalled. Copy diagnostics to investigate.');
    }
  }, 1000);
  const frame = (now: number) => {
    if (disposed || failed || !renderer) return;
    const started = performance.now();
    try {
      if (!document.hidden && now - last > 2000) {
        diagnostics.record('frame-gap', `${Math.round(now - last)}ms between frames; may indicate a freeze or browser suspension.`);
      }
      diagnostics.phase('frame-start');
      diagnostics.checkpoint(snapshot);
      // rAF timestamps can be slightly older than the performance.now() taken at boot.
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000)) * speed;
      last = now;
      if (!paused) {
        diagnostics.phase('world.update');
        world.update(dt);
        diagnostics.phase('director.update');
        director.update(world, dt);
      }
      const shake = world.events.cameraShake;
      inputSurface.style.setProperty('--camera-shake-x', `${shake.x}px`);
      inputSurface.style.setProperty('--camera-shake-y', `${shake.y}px`);
      diagnostics.phase('drag-and-highlights');
      if (drag && (drag.agent.room !== drag.origin || (drag.active && (drag.agent.incapacitated ||
        (drag.agent instanceof Creature ? !drag.agent.onCamera : drag.agent.leaving))))) {
        log(`Pickup cancelled: ${drag.agent.character.name} is no longer available.`, 'muted');
        cancelDrag();
      }
      if (followed) {
        const room = followCameraRoom(world, followed);
        if (room && room !== viewed && !drag?.active) switchCamera(room);
        updateFollowControls();
      }
      const navigationHint = updateDragCameraHover();
      const highlights = new Map<CameraActor | Remains, string>();
      if (selected instanceof Creature) highlights.set(selected, selected.character.tint);
      else if (selected && !selected.removed) highlights.set(selected, selected.revealed ? '#ff4060' : selected.character.tint);
      if (hovered) highlights.set(hovered, '#ffffff');
      if (hoveredRemains && !drag?.active && viewed.remains.includes(hoveredRemains)) highlights.set(hoveredRemains, '#ffffff');
      diagnostics.phase('renderer.draw');
      renderer.draw(world, highlights);
      diagnostics.phase('overlays');
      if (drag?.active) {
        const pointer = toRoom({ clientX: drag.client.x, clientY: drag.client.y });
        drag.point = { x: pointer.x - drag.offset.x, y: pointer.y - drag.offset.y };
        const target = currentDrop();
        renderer.drawHeld(drag.agent, drag.point, target.kind !== 'invalid');
        setDragStatus(`${drag.agent.character.name}: ${navigationHint ?? target.label}`);
        if (carry) {
          carry.hidden = pointer.x >= 0 && pointer.y >= 0 && pointer.x < viewed.width && pointer.y < viewed.height;
          carry.textContent = `Carrying ${drag.agent.character.name}`;
          carry.style.left = `${Math.max(8, Math.min(drag.client.x + 12, window.innerWidth - carry.offsetWidth - 8))}px`;
          carry.style.top = `${Math.max(8, Math.min(drag.client.y + 12, window.innerHeight - carry.offsetHeight - 8))}px`;
        }
      }
      if (editorPanel.editor?.active) editorPanel.editor.draw(renderer.context, renderer.scale, world.time);
      diagnostics.phase('tags.sync');
      tags.sync(world, renderer, {
        viewed, showAll: showAllTags, hovered, selected,
        heldHead: drag?.active ? { agent: drag.agent, head: drag.head } : undefined,
      });
      diagnostics.phase('file.render');
      file?.render(selected, viewed);
      vitals?.render(selected, viewed);
      incidents?.sync();
      diagnostics.phase('frame-complete');
      lastFrameCompleted = performance.now();
      stalled = false;
      if (lastFrameCompleted - started > 1000) {
        diagnostics.record('slow-frame', `${Math.round(lastFrameCompleted - started)}ms to update and render.`);
        diagnostics.checkpoint(snapshot, true);
      }
      raf = requestAnimationFrame(frame);
    } catch (error) {
      fail(error);
    }
  };

  diagnostics.phase('load-assets');
  diagnostics.checkpoint(snapshot, true);
  loadAssets(config.assets).then((assets) => {
    if (disposed) return;
    diagnostics.phase('renderer-init');
    renderer = new Renderer(canvas, assets, viewed);
    world.particles.setEmissionSampler(new PropEmissionSampler(assets).sample);
    propPicker = new PropPicker(assets);
    renderer.resize();
    if (debugPanel && debugMode) editorPanel.editor = new PropEditor(assets, viewed, editorPanel.render, (door) => world.passageDoorFor(door));
    diagnostics.phase('world.populate');
    world.populate();
    updateCameraCounts();
    log(`A1oS camera link established: ${rooms.length} feed${rooms.length === 1 ? '' : 's'} online.`, 'ok');
    if (status) status.hidden = true;
    root.classList.add('is-live');
    last = performance.now();
    lastFrameCompleted = last;
    diagnostics.phase('ready');
    diagnostics.checkpoint(snapshot, true);
    raf = requestAnimationFrame(frame);
  }).catch((error: unknown) => {
    if (!disposed) fail(error);
  });

  return () => {
    cancelDrag();
    disposed = true;
    delete root.dataset.monitorActive;
    cancelAnimationFrame(raf);
    window.clearInterval(clockTimer);
    window.clearInterval(watchdogTimer);
    listeners.dispose();
    window.clearTimeout(toastTimer);
    window.clearTimeout(staticTimer);
    editorPanel.dispose();
    resizeObserver.disconnect();
    inputSurface.style.removeProperty('--camera-shake-x');
    inputSurface.style.removeProperty('--camera-shake-y');
  };
}
