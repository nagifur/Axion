import { ACHIEVEMENTS } from './facilityEvents.ts';
import { clock, el } from './monitorDom.ts';
import type { MonitorDiagnostics } from './monitorDiagnostics.ts';
import { saveProgress, type Progress } from './monitorProgress.ts';
import type { SimCharacter } from './roster.ts';
import type { Room } from './room.ts';
import type { World, LogTone } from './world.ts';

const MAX_LOG_LINES = 40;
const TOAST_MS = 4000;

export function bindAchievements(
  root: HTMLElement, world: World, roster: SimCharacter[], progress: Progress,
  currentRoom: () => Room, diagnostics: MonitorDiagnostics,
) {
  const logNode = root.querySelector<HTMLOListElement>('[data-monitor-log]');
  const achievementList = root.querySelector<HTMLUListElement>('[data-monitor-achievements]');
  const achievementCount = root.querySelector<HTMLElement>('[data-monitor-achievement-count]');
  const rosterCount = root.querySelector<HTMLElement>('[data-monitor-roster-count]');
  const toast = root.querySelector<HTMLElement>('[data-monitor-toast]');
  const unlocked = new Set(progress.achievements);
  const identified = new Set(progress.identified);
  const camerasSeen = new Set(progress.cameras);
  let toastTimer = 0;

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
      const known = roster.filter((character) => identified.has(character.id)).length;
      rosterCount.textContent = `${known}/${roster.length}`;
    }
  };

  const achieve = (id: string, room?: Room) => {
    const achievement = ACHIEVEMENTS.find((item) => item.id === id);
    // Some achievements only count when they happen on the camera being watched.
    if (!achievement || unlocked.has(id) || (room && room !== currentRoom())) return;
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

  function visit(room: Room) {
    progress.camera = room.id;
    camerasSeen.add(room.id);
    progress.cameras = [...camerasSeen];
    saveProgress(progress);
    if (world.rooms.every((other) => camerasSeen.has(other.id))) achieve('channel-surfer');
  }

  function identify(id: string) {
    identified.add(id);
    progress.identified = [...identified];
    saveProgress(progress);
    renderAchievements();
    if (roster.every((character) => identified.has(character.id))) achieve('full-roster');
  }

  function reset() {
    unlocked.clear();
    identified.clear();
    camerasSeen.clear();
    camerasSeen.add(currentRoom().id);
    progress.achievements = [];
    progress.identified = [];
    progress.cameras = [...camerasSeen];
    saveProgress(progress);
    renderAchievements();
  }

  return { log, achieve, renderAchievements, visit, identify, reset, dispose: () => window.clearTimeout(toastTimer) };
}
