import { Creature } from './creature.ts';
import { cellDoorAt, dropTarget, placeActor, type DropTarget } from './agentDrag.ts';
import type { EventListeners } from './monitorDom.ts';
import type { EditorPanel } from './monitorEditor.ts';
import type { MonitorSelection } from './monitorSelection.ts';
import { NameTags } from './monitorTags.ts';
import type { PropPicker, Renderer } from './render.ts';
import type { Remains } from './remains.ts';
import type { Point, Room } from './room.ts';
import type { CameraActor, World, LogTone } from './world.ts';

const DRAG_CAMERA_HOVER_MS = 450;
const DRAG_START_PX = 5;

interface FeedInput {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  inputSurface: HTMLElement;
  tagLayer: HTMLElement;
  world: World;
  listeners: EventListeners;
  editorPanel: EditorPanel;
  selection: MonitorSelection;
  currentRoom(): Room;
  getRenderer(): Renderer | null;
  getPropPicker(): PropPicker | null;
  cameraOnLevel(level: number): Room | undefined;
  switchCamera(room: Room): void;
  updateCameraCounts(): void;
  log(message: string, tone: LogTone): void;
}

/** Pointer capture, carry/drop gestures and their on-screen feedback share one lifetime. */
export function bindFeedInput({
  root, canvas, inputSurface, tagLayer, world, listeners, editorPanel, selection,
  currentRoom, getRenderer, getPropPicker, cameraOnLevel, switchCamera, updateCameraCounts, log,
}: FeedInput) {
  const tagsToggle = root.querySelector<HTMLButtonElement>('[data-monitor-toggle-tags]');
  const dragStatus = root.querySelector<HTMLElement>('[data-monitor-drag-status]');
  const dragHelp = dragStatus?.textContent?.trim() ?? '';
  const carry = root.querySelector<HTMLElement>('[data-monitor-carry]');
  let showAllTags = true;
  let hovered: CameraActor | null = null;
  let hoveredRemains: Remains | null = null;
  let drag: {
    agent: CameraActor; pointerId: number; start: Point; client: Point; offset: Point;
    point: Point; head: Point; origin: Room; active: boolean;
  } | null = null;
  let dragCameraHover: HTMLButtonElement | null = null;
  let dragCameraTimer = 0;
  let dragSwitchPoint: Point | null = null;
  let suppressClick = false;
  let suppressDoubleClick = false;

  const tags = new NameTags(tagLayer, {
    select: selection.select,
    hover: (agent) => { hovered = agent; },
    hovered: () => hovered,
  });

  const toRoom = (event: { clientX: number; clientY: number }) => {
    const rect = canvas.getBoundingClientRect();
    const room = currentRoom();
    return {
      x: ((event.clientX - rect.left) / rect.width) * room.width,
      y: ((event.clientY - rect.top) / rect.height) * room.height,
    };
  };

  const actorAt = (event: { clientX: number; clientY: number }, point: Point) => {
    return tags.actorFor(document.elementFromPoint(event.clientX, event.clientY))
      ?? getRenderer()?.hitTest(world, point.x, point.y) ?? null;
  };

  const currentDrop = (): DropTarget => {
    if (!drag) return { kind: 'invalid', label: 'Nobody picked up' };
    const event = { clientX: drag.client.x, clientY: drag.client.y };
    const pointer = toRoom(event);
    const room = currentRoom();
    if (pointer.x < 0 || pointer.y < 0 || pointer.x >= room.width || pointer.y >= room.height) {
      return { kind: 'invalid', label: 'Drop inside the camera feed' };
    }
    const partner = actorAt(event, pointer);
    const prop = partner ? null : getPropPicker()?.at(room, pointer, world.time);
    const door = partner || prop ? undefined : cellDoorAt(world, room, pointer);
    return dropTarget(world, drag.agent, partner || prop || door ? pointer : drag.point, partner, prop, room, door);
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
    const viewed = currentRoom();
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
    const renderer = getRenderer();
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
    const renderer = getRenderer();
    if (!renderer || editorPanel.active) return;
    if (event.target instanceof Element && event.target.closest('.monitor-tag')) return;
    const point = toRoom(event);
    // Remains on the floor pull up the file of whoever they were.
    const agent = renderer.hitTest(world, point.x, point.y) ?? renderer.remainsAt(point.x, point.y)?.actor;
    if (agent) selection.select(agent);
  };
  const onDoubleClick = (event: MouseEvent) => {
    if (suppressDoubleClick) {
      suppressDoubleClick = false;
      return;
    }
    const renderer = getRenderer();
    if (!renderer || editorPanel.active || drag?.active) return;
    const actor = actorAt(event, toRoom(event));
    if (actor) {
      event.preventDefault();
      selection.toggleFollowing(actor);
    }
  };
  const onPointerDown = (event: PointerEvent) => {
    const renderer = getRenderer();
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
      selection.select(agent);
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
    if (event.key === 'Escape' && selection.followed && !editor?.active) {
      event.preventDefault();
      selection.stopFollowing();
      return;
    }
    if (event.key === 'Escape' && selection.selected && !editor?.active && !target?.closest('input, textarea, select')) {
      event.preventDefault();
      selection.clear();
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

  if (tagsToggle) listeners.listen(tagsToggle, 'click', () => {
    showAllTags = !showAllTags;
    tagsToggle.setAttribute('aria-pressed', String(showAllTags));
    tagsToggle.textContent = showAllTags ? 'Name tags: On' : 'Name tags: Hover';
  });

  function validatePickup() {
    if (drag && (drag.agent.room !== drag.origin || (drag.active && (drag.agent.incapacitated ||
      (drag.agent instanceof Creature ? !drag.agent.onCamera : drag.agent.leaving))))) {
      log(`Pickup cancelled: ${drag.agent.character.name} is no longer available.`, 'muted');
      cancelDrag();
    }
  }

  function highlights() {
    const { selected } = selection;
    const highlights = new Map<CameraActor | Remains, string>();
    if (selected instanceof Creature) highlights.set(selected, selected.character.tint);
    else if (selected && !selected.removed) highlights.set(selected, selected.revealed ? '#ff4060' : selected.character.tint);
    if (hovered) highlights.set(hovered, '#ffffff');
    if (hoveredRemains && !drag?.active && currentRoom().remains.includes(hoveredRemains)) highlights.set(hoveredRemains, '#ffffff');
    return highlights;
  }

  function drawHeld(renderer: Renderer, navigationHint: string | null) {
    const viewed = currentRoom();
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
  }

  function syncTags(renderer: Renderer) {
    tags.sync(world, renderer, {
      viewed: currentRoom(), showAll: showAllTags, hovered, selected: selection.selected,
      heldHead: drag?.active ? { agent: drag.agent, head: drag.head } : undefined,
    });
  }

  return {
    get held() { return drag?.active ? drag.agent : null; },
    cancelDrag, validatePickup, updateDragCameraHover, highlights, drawHeld, syncTags,
    clearHover() {
      hovered = null;
      hoveredRemains = null;
    },
    cameraChanged() {
      if (!drag?.active) return;
      clearDragCameraHover();
      // A new layout can move floor buttons under a stationary pointer.
      dragSwitchPoint = { ...drag.client };
    },
    removed(agent: CameraActor) {
      if (drag?.agent === agent) cancelDrag();
      if (hovered === agent) hovered = null;
    },
  };
}
