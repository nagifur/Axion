import { nap, trip, type Agent } from './agent';
import { ACHIEVEMENTS, EventDirector } from './events';
import { Renderer, loadAssets } from './render';
import type { SimCharacter, SimImpostor } from './roster';
import { Room, type RoomData } from './room';
import { World, type LogTone } from './world';

export interface MonitorConfig {
  roster: SimCharacter[];
  impostors: SimImpostor[];
  room: RoomData;
  /** Image URLs by name: "room", "character", and every prop file name. */
  assets: Record<string, string>;
}

interface Progress {
  achievements: string[];
  identified: string[];
}

const STORAGE_KEY = 'axion-monitor';
const MAX_LOG_LINES = 40;

function loadProgress(): Progress {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return {
      achievements: Array.isArray(stored.achievements) ? stored.achievements : [],
      identified: Array.isArray(stored.identified) ? stored.identified : [],
    };
  } catch {
    return { achievements: [], identified: [] };
  }
}

function saveProgress(progress: Progress) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Storage can be unavailable (private mode); progress just won't persist.
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const clock = (date: Date, seconds = false) =>
  date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: seconds ? '2-digit' : undefined, hour12: false });

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

  const room = new Room(config.room);
  const world = new World({ roster: config.roster, room });
  const director = new EventDirector(config.impostors);
  const progress = loadProgress();
  const unlocked = new Set(progress.achievements);
  const identified = new Set(progress.identified);

  let disposed = false;
  let raf = 0;
  let paused = false;
  let speed = 1;
  let showAllTags = true;
  let hovered: Agent | null = null;
  let selected: Agent | null = null;
  let renderer: Renderer | null = null;
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

  const achieve = (id: string) => {
    const achievement = ACHIEVEMENTS.find((item) => item.id === id);
    if (!achievement || unlocked.has(id)) return;
    unlocked.add(id);
    progress.achievements = [...unlocked];
    saveProgress(progress);
    renderAchievements();
    log(`Directive complete: ${achievement.title}`, 'ok');
    if (toast) {
      toast.textContent = `Directive complete: ${achievement.title}`;
      toast.hidden = false;
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => { toast.hidden = true; }, 4000);
    }
  };

  // --- Personnel file panel ----------------------------------------------

  let fileKey = '';
  let activityNode: HTMLElement | null = null;

  // True while the selected badge ID is shared with an undetected shapeshifter.
  const hasTwin = (agent: Agent) => world.agents.some((other) =>
    other !== agent && other.character.id === agent.character.id
    && ((other.impostor && !other.revealed) || (agent.impostor && !agent.revealed)));

  const renderFile = (agent: Agent | null) => {
    if (!fileNode) return;
    const twin = agent ? hasTwin(agent) : false;
    const key = agent ? `${agent.uid}|${agent.revealed}|${agent.removed}|${twin}` : '';
    if (key === fileKey) {
      if (agent && activityNode) activityNode.textContent = agent.removed ? 'Off camera' : agent.activity;
      return;
    }
    fileKey = key;

    if (!agent) {
      fileNode.replaceChildren(el('p', 'monitor-file-empty', 'Select someone on the feed to pull up their file.'));
      activityNode = null;
      return;
    }

    const revealed = agent.revealed && agent.impostor;
    const character = agent.character;
    const head = el('div', 'monitor-file-head');
    const image = revealed ? agent.impostor!.image : character.image;
    if (image) {
      const photo = el('img', 'monitor-file-photo');
      photo.src = image;
      photo.alt = '';
      photo.width = 72;
      photo.height = 72;
      head.append(photo);
    }
    const titleBlock = el('div', 'monitor-file-title');
    titleBlock.append(
      el('p', 'panel-kicker', revealed ? 'Entity file · Escaped' : `Personnel file · ID ${character.employeeID}`),
      el('h3', undefined, revealed ? `${agent.impostor!.name} "${agent.impostor!.nickname}"` : character.name),
      el('p', 'monitor-file-role', revealed ? `Shapeshifter posing as ${character.name}` : character.position),
    );
    head.append(titleBlock);
    fileNode.style.setProperty('--file-tint', revealed ? 'var(--neon-red)' : character.tint);

    const stats = el('dl', 'monitor-file-stats');
    const stat = (label: string, value: string) => {
      const row = el('div');
      const dd = el('dd', undefined, value);
      row.append(el('dt', undefined, label), dd);
      stats.append(row);
      return dd;
    };
    if (!revealed) {
      stat('Clearance', /^\d+$/.test(character.accessLevel) ? `Level ${character.accessLevel}` : character.accessLevel);
      stat('Species', character.species);
    }
    activityNode = stat('Status', agent.removed ? 'Off camera' : agent.activity);

    const parts: HTMLElement[] = [head, stats];
    if (twin) parts.push(el('p', 'monitor-file-warning', 'A1: Duplicate badge signal detected for this ID.'));
    if (!revealed && character.traits.length) {
      const traits = el('ul', 'monitor-file-traits');
      traits.append(...character.traits.map((trait) => el('li', undefined, trait)));
      parts.push(traits);
    }
    const link = el('a', 'btn monitor-file-link', 'Open database file →');
    link.href = revealed ? agent.impostor!.href : character.href;
    parts.push(link);
    fileNode.replaceChildren(...parts);
  };

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

  const tags = new Map<Agent, { button: HTMLButtonElement; name: HTMLElement; bubble: HTMLElement; label: string }>();

  const syncTags = () => {
    if (!renderer) return;
    for (const [agent, tag] of tags) {
      if (!world.agents.includes(agent)) {
        tag.button.remove();
        tags.delete(agent);
      }
    }

    const visibleTags: { agent: Agent; button: HTMLButtonElement; head: { x: number; y: number } }[] = [];
    for (const agent of world.agents) {
      let tag = tags.get(agent);
      if (!tag) {
        const button = el('button', 'monitor-tag');
        button.type = 'button';
        const bubble = el('span', 'monitor-tag-bubble');
        const name = el('span', 'monitor-tag-name');
        button.append(bubble, name);
        button.addEventListener('click', () => select(agent));
        button.addEventListener('pointerenter', () => { hovered = agent; });
        button.addEventListener('pointerleave', () => { if (hovered === agent) hovered = null; });
        tagLayer.append(button);
        tag = { button, name, bubble, label: '' };
        tags.set(agent, tag);
      }

      const revealed = agent.revealed && agent.impostor;
      const label = revealed ? `${agent.impostor!.name} "${agent.impostor!.nickname}"` : agent.character.name;
      if (tag.label !== label) {
        tag.label = label;
        tag.name.textContent = label;
        tag.button.setAttribute('aria-label', `${label}. Open file`);
        tag.button.style.setProperty('--tag-tint', revealed ? 'var(--neon-red)' : agent.character.tint);
      }
      const bubble = agent.bubble ?? '';
      if (tag.bubble.textContent !== bubble) tag.bubble.textContent = bubble;

      const visible = renderer.isVisible(agent, world);
      tag.button.hidden = !visible;
      tag.button.classList.toggle('is-quiet', !showAllTags && agent !== hovered && agent !== selected);
      tag.button.classList.toggle('is-active', agent === hovered || agent === selected);
      if (visible) visibleTags.push({ agent, button: tag.button, head: renderer.headPosition(agent) });
    }

    // Place tags front to back; any tag that would overlap one already placed moves up.
    const layerWidth = tagLayer.clientWidth;
    const layerHeight = tagLayer.clientHeight;
    const sized = visibleTags
      .map((tag) => ({ ...tag, width: tag.button.offsetWidth, height: tag.button.offsetHeight }))
      .sort((a, b) => b.agent.y - a.agent.y);
    const placed: { left: number; right: number; top: number; bottom: number }[] = [];
    for (const tag of sized) {
      const x = (tag.head.x / room.width) * layerWidth;
      let bottom = (Math.max(8, tag.head.y - 1) / room.height) * layerHeight;
      for (let attempt = 0; attempt < 8; attempt++) {
        const left = x - tag.width / 2;
        const right = x + tag.width / 2;
        const hit = placed.find((box) => left < box.right + 2 && right > box.left - 2 && bottom - tag.height < box.bottom && bottom > box.top);
        if (!hit) break;
        bottom = hit.top - 1;
      }
      placed.push({ left: x - tag.width / 2, right: x + tag.width / 2, top: bottom - tag.height, bottom });
      tag.button.style.left = `${x}px`;
      tag.button.style.top = `${bottom}px`;
    }
  };

  // --- Input ---------------------------------------------------------------

  const toRoom = (event: PointerEvent | MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * room.width,
      y: ((event.clientY - rect.top) / rect.height) * room.height,
    };
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!renderer) return;
    const point = toRoom(event);
    hovered = renderer.hitTest(world, point.x, point.y);
    canvas.style.cursor = hovered ? 'pointer' : '';
  };
  const onPointerLeave = () => {
    hovered = null;
    canvas.style.cursor = '';
  };
  const onClick = (event: MouseEvent) => {
    if (!renderer) return;
    const point = toRoom(event);
    const agent = renderer.hitTest(world, point.x, point.y);
    if (agent) select(agent);
  };
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('click', onClick);

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

  if (debugPanel && new URLSearchParams(location.search).has('debug')) {
    debugPanel.hidden = false;
    const randomAgent = () => world.agents.filter((agent) => !agent.busy)[0];
    const actions: Record<string, () => void> = {
      impostor: () => { if (!director.triggerImpostor(world)) log('Debug: no impostor possible right now.', 'muted'); },
      arrive: () => { if (!world.arrive()) log('Debug: everyone is already on the floor.', 'muted'); },
      nap: () => randomAgent()?.setPlan(world, [nap(20, 'front')]),
      trip: () => randomAgent()?.interrupt(world, trip()),
      announce: () => director.announce(world),
      speed: () => { speed = speed === 1 ? 4 : 1; log(`Debug: speed x${speed}.`, 'muted'); },
      reset: () => {
        unlocked.clear();
        identified.clear();
        progress.achievements = [];
        progress.identified = [];
        saveProgress(progress);
        renderAchievements();
      },
    };
    debugPanel.addEventListener('click', (event) => {
      const action = (event.target as HTMLElement).closest<HTMLElement>('[data-debug]')?.dataset.debug;
      if (action) actions[action]?.();
    });
  }

  // --- Clock & status ------------------------------------------------------

  const tick = () => {
    const now = world.now();
    if (clockNode) clockNode.textContent = clock(now, true);
    if (now.getHours() < 5) achieve('night-shift');
    if (alertNode) {
      const duplicate = world.agents.some((agent) => agent.impostor && !agent.revealed);
      alertNode.textContent = duplicate ? 'Duplicate badge' : 'All clear';
      alertNode.classList.toggle('is-alert', duplicate);
    }
  };
  tick();
  const clockTimer = window.setInterval(tick, 1000);

  // --- Boot ----------------------------------------------------------------

  world.hooks = {
    log,
    achieve,
    removed: (agent) => { if (hovered === agent) hovered = null; },
  };
  renderAchievements();
  renderFile(null);

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
    const highlights = new Map<Agent, string>();
    if (selected && !selected.removed) highlights.set(selected, selected.revealed ? '#ff4060' : selected.character.tint);
    if (hovered) highlights.set(hovered, '#ffffff');
    renderer.draw(world, highlights);
    syncTags();
    renderFile(selected);
    raf = requestAnimationFrame(frame);
  };

  loadAssets(config.assets).then((assets) => {
    if (disposed) return;
    renderer = new Renderer(canvas, assets, room);
    renderer.resize();
    world.populate();
    log(`A1oS camera link established: ${room.camera}, ${room.label} ${room.name}.`, 'ok');
    if (status) status.hidden = true;
    root.classList.add('is-live');
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }).catch(() => {
    if (status) status.textContent = 'Feed unavailable';
  });

  return () => {
    disposed = true;
    delete root.dataset.monitorActive;
    cancelAnimationFrame(raf);
    window.clearInterval(clockTimer);
    window.clearTimeout(toastTimer);
    resizeObserver.disconnect();
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('click', onClick);
  };
}
