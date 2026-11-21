import type { Agent } from './agent.ts';
import { dropTarget, placeAgent, type DropTarget } from './agentDrag.ts';
import { ACHIEVEMENTS, EventDirector } from './events.ts';
import { bindDebugPanel } from './monitorDebug.ts';
import { clock, el } from './monitorDom.ts';
import { EditorPanel } from './monitorEditor.ts';
import { PersonnelFile } from './monitorFile.ts';
import { loadProgress, saveProgress } from './monitorProgress.ts';
import { NameTags } from './monitorTags.ts';
import { PropEditor } from './propEditor.ts';
import { PropEmissionSampler, PropPicker, Renderer, loadAssets } from './render.ts';
import type { SimCharacter, SimImpostor } from './roster.ts';
import { Room, type Point, type RoomData } from './room.ts';
import { World, type LogTone } from './world.ts';

export interface MonitorConfig {
  roster: SimCharacter[];
  impostors: SimImpostor[];
  /** Every room on camera, in floor-plan order. */
  rooms: RoomData[];
  /** Room shown when nobody has picked a camera yet. */
  initialRoom: string;
  /** Image URLs by name: "room:<id>", "character", prop names, "item:<type>", and "particle:<file>". */
  assets: Record<string, string>;
}

const MAX_LOG_LINES = 40;
const SWITCH_STATIC_MS = 220;
const DRAG_CAMERA_HOVER_MS = 450;
const DRAG_HELP = 'Drag an agent to open floor, a prop, or another agent. Hold over a floor or camera to switch. Esc cancels.';
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

  const config: MonitorConfig = JSON.parse(configNode.textContent ?? '{}');
  const status = root.querySelector<HTMLElement>('[data-monitor-status]');
  const clockNode = root.querySelector<HTMLElement>('[data-monitor-clock]');
  const alertNode = root.querySelector<HTMLElement>('[data-monitor-alert]');
  const fileNode = root.querySelector<HTMLElement>('[data-monitor-file]');
  const logNode = root.querySelector<HTMLOListElement>('[data-monitor-log]');
  const achievementList = root.querySelector<HTMLUListElement>('[data-monitor-achievements]');
  const achievementCount = root.querySelector<HTMLElement>('[data-monitor-achievement-count]');
  const rosterCount = root.querySelector<HTMLElement>('[data-monitor-roster-count]');
  const toast = root.querySelector<HTMLElement>('[data-monitor-toast]');
  const tagsToggle = root.querySelector<HTMLButtonElement>('[data-monitor-toggle-tags]');
  const pauseToggle = root.querySelector<HTMLButtonElement>('[data-monitor-toggle-pause]');
  const debugPanel = root.querySelector<HTMLElement>('[data-monitor-debug]');
  const screen = root.querySelector<HTMLElement>('[data-monitor-screen]');
  const stage = root.querySelector<HTMLElement>('[data-monitor-stage]');
  const dragStatus = root.querySelector<HTMLElement>('[data-monitor-drag-status]');
  const carry = root.querySelector<HTMLElement>('[data-monitor-carry]');
  const inputSurface = stage ?? canvas;
  const camTitle = root.querySelector<HTMLElement>('[data-monitor-cam-title]');
  const cameraButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-monitor-camera]')];
  const levelButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-monitor-level]')];
  const levelRows = [...root.querySelectorAll<HTMLElement>('[data-monitor-level-row]')];

  const rooms = config.rooms.map((data) => new Room(data));
  // Milliseconds added to the real clock by the debug time override (0 = live).
  let clockOffset = 0;
  const world = new World({ roster: config.roster, rooms, now: () => new Date(Date.now() + clockOffset) });
  const director = new EventDirector(config.impostors);
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
  let hovered: Agent | null = null;
  let selected: Agent | null = null;
  let renderer: Renderer | null = null;
  let propPicker: PropPicker | null = null;
  let drag: {
    agent: Agent; pointerId: number; start: Point; client: Point; offset: Point;
    point: Point; head: Point; origin: Room; active: boolean;
  } | null = null;
  let dragCameraHover: HTMLButtonElement | null = null;
  let dragCameraTimer = 0;
  let dragSwitchPoint: Point | null = null;
  let suppressClick = false;
  let toastTimer = 0;

  // --- Log & achievements -------------------------------------------------

  const log = (text: string, tone: LogTone = 'default') => {
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

  const switchCamera = (room: Room) => {
    const changed = room !== viewed;
    if (changed && !drag?.active) cancelDrag();
    viewed = room;
    refreshDebugEvents?.();
    // Same pixel scale on every camera, so characters don't change size between rooms.
    if (stage) stage.style.width = `${(room.width / maxRoomWidth) * 100}%`;
    canvas.style.aspectRatio = `${room.width} / ${room.height}`;
    if (changed) {
      hovered = null;
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
    canvas.setAttribute('aria-label', `Live camera feed of the ${room.label} ${room.name}. Use the name tags to open personnel files.`);
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
    if (room) switchCamera(room);
  };
  for (const button of cameraButtons) button.addEventListener('click', onCameraClick);

  // Changing floor shows the camera last watched there, else the one on the same elevator shaft
  // as the current camera (so "down" from the Offices lands in the room below), else the first one.
  const cameraOnLevel = (level: number) => {
    if (level === viewed.level) return viewed;
    const sameShaft = world.elevatorStops(viewed).find((room) => room.level === level);
    return lastRoomOnLevel.get(level) ?? sameShaft ?? rooms.find((room) => room.level === level);
  };
  const onLevelClick = (event: MouseEvent) => {
    const target = cameraOnLevel(Number((event.currentTarget as HTMLElement).dataset.monitorLevel));
    if (target) switchCamera(target);
  };
  for (const button of levelButtons) button.addEventListener('click', onLevelClick);

  const updateCameraCounts = () => {
    for (const button of cameraButtons) {
      const room = world.room(button.dataset.monitorCamera ?? '');
      const count = button.querySelector('[data-monitor-camera-count]');
      if (room && count) count.textContent = String(world.agentsIn(room).length);
    }
    for (const button of levelButtons) {
      const level = Number(button.dataset.monitorLevel);
      const count = button.querySelector('[data-monitor-level-count]');
      if (count) count.textContent = String(world.agents.filter((agent) => agent.room.level === level).length);
    }
  };

  // --- Personnel file & selection ---------------------------------------

  const file = fileNode ? new PersonnelFile(fileNode, world, (room) => switchCamera(room)) : null;

  const select = (agent: Agent) => {
    selected = agent;
    world.interact(agent);
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

  const agentAt = (event: { clientX: number; clientY: number }, point: Point) => {
    return tags.agentFor(document.elementFromPoint(event.clientX, event.clientY))
      ?? renderer?.hitTest(world, point.x, point.y) ?? null;
  };

  const currentDrop = (): DropTarget => {
    if (!drag) return { kind: 'invalid', label: 'No agent picked up' };
    const event = { clientX: drag.client.x, clientY: drag.client.y };
    const pointer = toRoom(event);
    if (pointer.x < 0 || pointer.y < 0 || pointer.x >= viewed.width || pointer.y >= viewed.height) {
      return { kind: 'invalid', label: 'Drop inside the camera feed' };
    }
    const partner = agentAt(event, pointer);
    const prop = partner ? null : propPicker?.at(viewed, pointer, world.time);
    return dropTarget(world, drag.agent, partner || prop ? pointer : drag.point, partner, prop, viewed);
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
    setDragStatus(DRAG_HELP);
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
          log(`${drag.agent.character.name} cannot be picked up while incapacitated or during a doorway or elevator transition.`, 'warn');
          cancelDrag();
          suppressClick = true;
          return;
        }
        drag.active = true;
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
    canvas.style.cursor = hovered ? (hovered.draggable ? 'grab' : 'pointer') : '';
  };
  const onPointerLeave = () => {
    if (drag) return;
    hovered = null;
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
    const agent = renderer.hitTest(world, point.x, point.y);
    if (agent) select(agent);
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!renderer || event.button !== 0 || !event.isPrimary || drag) return;
    suppressClick = false;
    if (editorPanel.editor?.active) {
      inputSurface.setPointerCapture(event.pointerId);
      editorPanel.editor.pointerDown(toRoom(event), world.time);
      return;
    }
    const point = toRoom(event);
    const agent = agentAt(event, point);
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
      placeAgent(world, agent, target);
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
    if (!editor?.active || target?.closest('input, textarea')) return;
    if (editor.key(event)) event.preventDefault();
  };
  inputSurface.addEventListener('pointermove', onPointerMove);
  inputSurface.addEventListener('pointerleave', onPointerLeave);
  inputSurface.addEventListener('click', onClick, true);
  inputSurface.addEventListener('pointerdown', onPointerDown);
  inputSurface.addEventListener('pointerup', onPointerUp);
  inputSurface.addEventListener('pointercancel', onPointerCancel);
  inputSurface.addEventListener('lostpointercapture', onPointerCancel);
  window.addEventListener('blur', onPointerCancel);
  window.addEventListener('keydown', onKeyDown);

  tagsToggle?.addEventListener('click', () => {
    showAllTags = !showAllTags;
    tagsToggle.setAttribute('aria-pressed', String(showAllTags));
    tagsToggle.textContent = showAllTags ? 'Name tags: On' : 'Name tags: Hover';
  });
  pauseToggle?.addEventListener('click', () => {
    paused = !paused;
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
    root.classList.toggle('is-editing', active);
    debugPanel?.querySelector('[data-debug="props"]')?.setAttribute('aria-pressed', String(active));
    hovered = null;
  };

  const debugMode = !!debugPanel && new URLSearchParams(location.search).has('debug');
  if (debugPanel && debugMode) {
    refreshDebugEvents = bindDebugPanel(debugPanel, {
      world,
      director,
      log,
      onCamera: () => world.agentsIn(viewed),
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
    });
  }

  // --- Clock & status ------------------------------------------------------

  const tick = () => {
    const now = world.now();
    if (clockNode) clockNode.textContent = clock(now, true);
    if (!clockOffset && now.getHours() < 5) achieve('night-shift');
    if (alertNode) {
      const duplicate = world.everyone().some((agent) => agent.impostor && !agent.revealed);
      alertNode.textContent = duplicate ? 'Duplicate badge' : 'All clear';
      alertNode.classList.toggle('is-alert', duplicate);
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
    },
  };
  renderAchievements();
  file?.render(null, viewed);
  switchCamera(viewed);

  const resizeObserver = new ResizeObserver(() => renderer?.resize());
  resizeObserver.observe(canvas);

  let last = performance.now();
  const frame = (now: number) => {
    if (disposed || !renderer) return;
    // rAF timestamps can be slightly older than the performance.now() taken at boot.
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000)) * speed;
    last = now;
    if (!paused) {
      world.update(dt);
      director.update(world, dt);
    }
    if (drag && (drag.agent.room !== drag.origin || (drag.active && drag.agent.leaving))) {
      log(`Pickup cancelled: ${drag.agent.character.name} is leaving the camera.`, 'muted');
      cancelDrag();
    }
    const navigationHint = updateDragCameraHover();
    const highlights = new Map<Agent, string>();
    if (selected && !selected.removed) highlights.set(selected, selected.revealed ? '#ff4060' : selected.character.tint);
    if (hovered) highlights.set(hovered, '#ffffff');
    renderer.draw(world, highlights);
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
    tags.sync(world, renderer, {
      viewed, showAll: showAllTags, hovered, selected,
      heldHead: drag?.active ? { agent: drag.agent, head: drag.head } : undefined,
    });
    file?.render(selected, viewed);
    raf = requestAnimationFrame(frame);
  };

  loadAssets(config.assets).then((assets) => {
    if (disposed) return;
    renderer = new Renderer(canvas, assets, viewed);
    world.particles.setEmissionSampler(new PropEmissionSampler(assets).sample);
    propPicker = new PropPicker(assets);
    renderer.resize();
    if (debugMode) editorPanel.editor = new PropEditor(assets, viewed, editorPanel.render, (door) => world.passageDoorFor(door));
    world.populate();
    updateCameraCounts();
    log(`A1oS camera link established: ${rooms.length} feed${rooms.length === 1 ? '' : 's'} online.`, 'ok');
    if (status) status.hidden = true;
    root.classList.add('is-live');
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }).catch(() => {
    if (status) status.textContent = 'Feed unavailable';
  });

  return () => {
    cancelDrag();
    disposed = true;
    delete root.dataset.monitorActive;
    cancelAnimationFrame(raf);
    window.clearInterval(clockTimer);
    window.clearTimeout(toastTimer);
    window.clearTimeout(staticTimer);
    editorPanel.dispose();
    resizeObserver.disconnect();
    inputSurface.removeEventListener('pointermove', onPointerMove);
    inputSurface.removeEventListener('pointerleave', onPointerLeave);
    inputSurface.removeEventListener('click', onClick, true);
    inputSurface.removeEventListener('pointerdown', onPointerDown);
    inputSurface.removeEventListener('pointerup', onPointerUp);
    inputSurface.removeEventListener('pointercancel', onPointerCancel);
    inputSurface.removeEventListener('lostpointercapture', onPointerCancel);
    window.removeEventListener('blur', onPointerCancel);
    window.removeEventListener('keydown', onKeyDown);
    for (const button of cameraButtons) button.removeEventListener('click', onCameraClick);
    for (const button of levelButtons) button.removeEventListener('click', onLevelClick);
  };
}
