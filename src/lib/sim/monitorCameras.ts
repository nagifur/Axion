import type { EventListeners } from './monitorDom.ts';
import type { World } from './world.ts';
import type { Room } from './room.ts';

const SWITCH_STATIC_MS = 220;

export function bindCameraControls(
  root: HTMLElement, canvas: HTMLCanvasElement, stage: HTMLElement | null, world: World,
  listeners: EventListeners, currentRoom: () => Room, navigate: (room: Room) => void,
) {
  const screen = root.querySelector<HTMLElement>('[data-monitor-screen]');
  const camTitle = root.querySelector<HTMLElement>('[data-monitor-cam-title]');
  const cameraButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-monitor-camera]')];
  const levelButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-monitor-level]')];
  const levelRows = [...root.querySelectorAll<HTMLElement>('[data-monitor-level-row]')];
  const maxRoomWidth = Math.max(...world.rooms.map((room) => room.width));
  let staticTimer = 0;
  const lastRoomOnLevel = new Map<number, Room>();

  function show(room: Room, changed: boolean) {
    // Same pixel scale on every camera, so characters don't change size between rooms.
    if (stage) stage.style.width = `${(room.width / maxRoomWidth) * 100}%`;
    canvas.style.aspectRatio = `${room.width} / ${room.height}`;
    if (changed && screen) {
      // A burst of static, like a real CCTV feed changing channel.
      screen.classList.remove('is-switching');
      void screen.offsetWidth;
      screen.classList.add('is-switching');
      window.clearTimeout(staticTimer);
      staticTimer = window.setTimeout(() => screen.classList.remove('is-switching'), SWITCH_STATIC_MS);
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
  }

  const onCameraClick = (event: MouseEvent) => {
    const id = (event.currentTarget as HTMLElement).dataset.monitorCamera;
    const room = id && world.room(id);
    if (room) navigate(room);
  };
  for (const button of cameraButtons) listeners.listen(button, 'click', onCameraClick);

  // Changing floor shows the camera last watched there, else the one on the same elevator shaft
  // as the current camera (so "down" from the Offices lands in the room below), else the first one.
  const cameraOnLevel = (level: number) => {
    const viewed = currentRoom();
    if (level === viewed.level) return viewed;
    const sameShaft = world.elevatorStops(viewed).find((room) => room.level === level);
    return lastRoomOnLevel.get(level) ?? sameShaft ?? world.rooms.find((room) => room.level === level);
  };
  const onLevelClick = (event: MouseEvent) => {
    const target = cameraOnLevel(Number((event.currentTarget as HTMLElement).dataset.monitorLevel));
    if (target) navigate(target);
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

  return { show, cameraOnLevel, updateCameraCounts, dispose: () => window.clearTimeout(staticTimer) };
}
