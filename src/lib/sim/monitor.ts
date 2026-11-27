import { Creature } from './creature.ts';
import { FacilityEventDirector } from './facilityEvents.ts';
import { bindAchievements } from './monitorAchievements.ts';
import { bindCameraControls } from './monitorCameras.ts';
import { bindDebugPanel } from './monitorDebug.ts';
import { bindMonitorDiagnostics, diagnosticError, type MonitorDiagnostics } from './monitorDiagnostics.ts';
import { clock, EventListeners } from './monitorDom.ts';
import { EditorPanel } from './monitorEditor.ts';
import { MonitorFile } from './monitorFile.ts';
import { bindFrameLoop } from './monitorFrameLoop.ts';
import { IncidentFeed } from './monitorIncidents.ts';
import { bindFeedInput } from './monitorInput.ts';
import { loadProgress } from './monitorProgress.ts';
import { bindSelection } from './monitorSelection.ts';
import { VitalsHud } from './monitorVitals.ts';
import { PropEditor } from './propEditor.ts';
import { PropEmissionSampler, PropPicker, Renderer, loadAssets } from './render.ts';
import type { SimCharacter, SimCreature, SimImpostor } from './roster.ts';
import { Room, type RoomData } from './room.ts';
import { World } from './world.ts';

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
  const incidentNode = root.querySelector<HTMLOListElement>('[data-monitor-incidents]');
  const pauseToggle = root.querySelector<HTMLButtonElement>('[data-monitor-toggle-pause]');
  const debugPanel = root.querySelector<HTMLElement>('[data-monitor-debug]');
  const stage = root.querySelector<HTMLElement>('[data-monitor-stage]');
  const inputSurface = stage ?? canvas;
  const listeners = new EventListeners();

  const rooms = config.rooms.map((data) => new Room(data));
  // Milliseconds added to the real clock by the debug time override (0 = live).
  let clockOffset = 0;
  const world = new World({ roster: config.roster, creatureRoster: config.creatureRoster, rooms, now: () => new Date(Date.now() + clockOffset) });
  const director = new FacilityEventDirector(config.impostors);
  const progress = loadProgress();
  let viewed = world.room(progress.camera ?? '') ?? world.room(config.initialRoom) ?? rooms[0];
  let refreshDebugEvents: (() => void) | undefined;

  let disposed = false;
  let paused = false;
  let speed = 1;
  let renderer: Renderer | null = null;
  let propPicker: PropPicker | null = null;

  const currentRoom = () => viewed;
  const achievements = bindAchievements(root, world, config.roster, progress, currentRoom, diagnostics);
  const { log, achieve } = achievements;
  const selection = bindSelection(root, world, listeners, achievements.identify, achieve);
  function navigate(room: Room) {
    selection.stopFollowing();
    switchCamera(room);
  }
  const cameras = bindCameraControls(root, canvas, stage, world, listeners, currentRoom, navigate);
  const editorPanel = new EditorPanel(root.querySelector<HTMLElement>('[data-monitor-editor]'), root);
  const input = bindFeedInput({
    root, canvas, inputSurface, tagLayer, world, listeners, selection, editorPanel,
    currentRoom, getRenderer: () => renderer, getPropPicker: () => propPicker,
    cameraOnLevel: cameras.cameraOnLevel, updateCameraCounts: cameras.updateCameraCounts, switchCamera, log,
  });

  function switchCamera(room: Room): void {
    const changed = room !== viewed;
    if (changed) diagnostics.record('camera', `${viewed.id} -> ${room.id}`);
    if (changed && !input.held) input.cancelDrag();
    viewed = room;
    refreshDebugEvents?.();
    cameras.show(room, changed);
    if (changed) {
      input.clearHover();
      renderer?.setRoom(room);
      editorPanel.editor?.setRoom(room);
    }
    achievements.visit(room);
    if (changed) input.cameraChanged();
  }

  const file = fileNode ? new MonitorFile(fileNode, world, navigate) : null;
  const vitals = vitalsNode ? new VitalsHud(vitalsNode, world) : null;

  const incidents = incidentNode ? new IncidentFeed(
    incidentNode,
    root.querySelector<HTMLElement>('[data-monitor-incidents-empty]'),
    root.querySelector<HTMLElement>('[data-monitor-incident-count]'),
    world.incidents, listeners,
    navigate,
  ) : null;

  const snapshot = () => ({
    camera: viewed.id, paused, speed, clockOffset, simulationTime: world.time,
    simulationClock: world.now().toISOString(), visibility: document.visibilityState,
    selected: selection.selected?.character.id ?? null, followed: selection.followed?.character.id ?? null,
    held: input.held instanceof Creature ? input.held.character.id : input.held?.uid ?? null,
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

  if (pauseToggle) listeners.listen(pauseToggle, 'click', () => {
    paused = !paused;
    diagnostics.record('pause', String(paused));
    pauseToggle.setAttribute('aria-pressed', String(paused));
    pauseToggle.textContent = paused ? 'Resume feed' : 'Pause feed';
    root.classList.toggle('is-paused', paused);
  });

  // --- Debug tools (?debug) ----------------------------------------------

  const toggleEditor = () => {
    if (!editorPanel.editor) return;
    input.cancelDrag();
    const active = editorPanel.toggle();
    if (active) selection.stopFollowing();
    root.classList.toggle('is-editing', active);
    debugPanel?.querySelector('[data-debug="props"]')?.setAttribute('aria-pressed', String(active));
    input.clearHover();
  };

  if (debugPanel && debugMode) {
    refreshDebugEvents = bindDebugPanel(debugPanel, {
      world,
      director,
      log,
      onCamera: () => world.agentsIn(viewed),
      selected: () => selection.selected,
      currentRoom,
      setClockOffset: (ms) => { clockOffset = ms; },
      refreshClock: () => tick(),
      toggleSpeed: () => {
        speed = speed === 1 ? DEBUG_FAST_SPEED : 1;
        log(`Debug: speed x${speed}.`, 'muted');
      },
      toggleEditor,
      resetProgress: achievements.reset,
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
    cameras.updateCameraCounts();
  };
  tick();
  const clockTimer = window.setInterval(tick, 1000);

  // --- Boot ----------------------------------------------------------------

  world.hooks = {
    log,
    achieve,
    removed: (agent) => {
      input.removed(agent);
      selection.removed(agent);
    },
  };
  achievements.renderAchievements();
  file?.render(null, viewed);
  switchCamera(viewed);

  const resizeObserver = new ResizeObserver(() => renderer?.resize());
  resizeObserver.observe(canvas);

  const loop = bindFrameLoop(listeners, diagnostics, snapshot, notifyDiagnostics, () => {
    if (!status) return;
    status.hidden = false;
    status.textContent = debugMode
      ? 'Feed stopped: copy diagnostics below'
      : 'Feed stopped: reopen this page with ?debug for diagnostics';
  });

  function drawFrame(renderer: Renderer, elapsed: number) {
    if (!paused) {
      const dt = elapsed * speed;
      diagnostics.phase('world.update');
      world.update(dt);
      diagnostics.phase('director.update');
      director.update(world, dt);
    }
    const shake = world.events.cameraShake;
    inputSurface.style.setProperty('--camera-shake-x', `${shake.x}px`);
    inputSurface.style.setProperty('--camera-shake-y', `${shake.y}px`);
    diagnostics.phase('drag-and-highlights');
    input.validatePickup();
    selection.track(viewed, !!input.held, switchCamera);
    const navigationHint = input.updateDragCameraHover();
    const highlights = input.highlights();
    diagnostics.phase('renderer.draw');
    renderer.draw(world, highlights);
    diagnostics.phase('overlays');
    input.drawHeld(renderer, navigationHint);
    if (editorPanel.editor?.active) editorPanel.editor.draw(renderer.context, renderer.scale, world.time);
    diagnostics.phase('tags.sync');
    input.syncTags(renderer);
    diagnostics.phase('file.render');
    file?.render(selection.selected, viewed);
    vitals?.render(selection.selected, viewed);
    incidents?.sync();
  }

  diagnostics.phase('load-assets');
  diagnostics.checkpoint(snapshot, true);
  loadAssets(config.assets).then((assets) => {
    if (disposed) return;
    diagnostics.phase('renderer-init');
    const liveRenderer = new Renderer(canvas, assets, viewed);
    renderer = liveRenderer;
    world.particles.setEmissionSampler(new PropEmissionSampler(assets).sample);
    propPicker = new PropPicker(assets);
    renderer.resize();
    if (debugPanel && debugMode) editorPanel.editor = new PropEditor(assets, viewed, editorPanel.render, (door) => world.passageDoorFor(door));
    diagnostics.phase('world.populate');
    world.populate();
    cameras.updateCameraCounts();
    log(`A1oS camera link established: ${rooms.length} feed${rooms.length === 1 ? '' : 's'} online.`, 'ok');
    if (status) status.hidden = true;
    root.classList.add('is-live');
    loop.start((dt) => drawFrame(liveRenderer, dt));
  }).catch((error: unknown) => {
    if (!disposed) loop.fail(error);
  });

  return () => {
    input.cancelDrag();
    disposed = true;
    delete root.dataset.monitorActive;
    loop.dispose();
    window.clearInterval(clockTimer);
    listeners.dispose();
    achievements.dispose();
    cameras.dispose();
    editorPanel.dispose();
    resizeObserver.disconnect();
    inputSurface.style.removeProperty('--camera-shake-x');
    inputSurface.style.removeProperty('--camera-shake-y');
  };
}
