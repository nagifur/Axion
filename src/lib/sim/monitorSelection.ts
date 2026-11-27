import { Creature } from './creature.ts';
import type { EventListeners } from './monitorDom.ts';
import { followCameraRoom } from './monitorFollow.ts';
import type { CameraActor, World } from './world.ts';
import type { Room } from './room.ts';

export function bindSelection(
  root: HTMLElement, world: World, listeners: EventListeners,
  identify: (id: string) => void, achieve: (id: string) => void,
) {
  const followToggle = root.querySelector<HTMLButtonElement>('[data-monitor-toggle-follow]');
  const followStatus = root.querySelector<HTMLElement>('[data-monitor-follow-status]');
  let selected: CameraActor | null = null;
  let followed: CameraActor | null = null;

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

  const select = (agent: CameraActor) => {
    selected = agent;
    updateFollowControls();
    if (agent instanceof Creature) return;
    if (!agent.removed) world.interact(agent);
    if (!agent.character.href) return;
    if (!agent.impostor) identify(agent.character.id);
    achieve('first-contact');
  };

  if (followToggle) listeners.listen(followToggle, 'click', () => {
    if (followed) stopFollowing();
    else if (selected) toggleFollowing(selected);
  });

  return {
    get selected() { return selected; },
    get followed() { return followed; },
    select, stopFollowing, toggleFollowing,
    clear() {
      selected = null;
      updateFollowControls();
    },
    track(viewed: Room, dragging: boolean, switchCamera: (room: Room) => void) {
      if (!followed) return;
      const room = followCameraRoom(world, followed);
      if (room && room !== viewed && !dragging) switchCamera(room);
      updateFollowControls();
    },
    removed(agent: CameraActor) {
      if (followed === agent && !world.vore.consumed.has(agent.character.id)) stopFollowing();
      else if (selected === agent) updateFollowControls();
    },
  };
}

export type MonitorSelection = ReturnType<typeof bindSelection>;
