import { navigate } from 'astro:transitions/client';

export type OutputTone = 'default' | 'ok' | 'denied' | 'muted';

export interface TerminalContext {
  args: string[];
  raw: string;
  print: (text: string, tone?: OutputTone) => void;
  clear: () => void;
  open: (href: string) => void;
  history: readonly string[];
}

export interface TerminalCommand {
  description: string;
  usage?: string;
  aliases?: string[];
  /** Hidden commands work but are never listed by `help`. */
  hidden?: boolean;
  run: (ctx: TerminalContext) => void | Promise<void>;
}

const destinations: Record<string, string> = {
  home: '/',
  database: '/database',
  archive: '/database',
  facility: '/facility',
  about: '/about',
  contact: '/contact',
  submit: '/submit',
  reports: '/Articles',
  articles: '/Articles',
};

function resolveDestination(target: string): string | null {
  const key = target.toLowerCase();
  if (destinations[key]) return destinations[key];
  const level = key.match(/^(?:level-?|l)?([0-5])$/);
  if (level) return `/Levels/${level[1]}`;
  const cls = key.match(/^class-?([acmsx])$/);
  if (cls) return `/Classes/${cls[1]}`;
  return null;
}

export const commands: Record<string, TerminalCommand> = {
  help: {
    description: 'List available commands',
    aliases: ['?'],
    run: ({ print }) => {
      print('Available commands:');
      const visible = Object.entries(commands).filter(([, cmd]) => !cmd.hidden);
      const width = Math.max(...visible.map(([name, cmd]) => (cmd.usage ?? name).length));
      for (const [name, cmd] of visible) {
        print(`  ${(cmd.usage ?? name).padEnd(width)}  ${cmd.description}`, 'muted');
      }
    },
  },
  open: {
    description: 'Open a page (try: open database, open level 2)',
    usage: 'open <page>',
    aliases: ['goto', 'cd'],
    run: ({ args, print, open }) => {
      const target = args.join('');
      if (!target) {
        print(`Usage: open <page>`);
        print(`Pages: ${Object.keys(destinations).join(', ')}, level <0-5>`, 'muted');
        return;
      }
      const href = resolveDestination(target);
      if (!href) {
        print(`open: destination "${args.join(' ')}" not found`, 'denied');
        return;
      }
      print(`Routing to ${href} ...`, 'ok');
      open(href);
    },
  },
  echo: {
    description: 'Print text back to the console',
    usage: 'echo <text>',
    run: ({ args, print }) => print(args.join(' ')),
  },
  date: {
    description: 'Show facility time',
    aliases: ['time'],
    run: ({ print }) => print(new Date().toString()),
  },
  whoami: {
    description: 'Show current user',
    run: ({ print }) => print('guest@axion-labs [clearance: visitor]'),
  },
  history: {
    description: 'Show command history',
    run: ({ print, history }) => {
      if (!history.length) return print('No history.', 'muted');
      history.forEach((entry, i) => print(`  ${String(i + 1).padStart(3)}  ${entry}`, 'muted'));
    },
  },
  clear: {
    description: 'Clear the console',
    aliases: ['cls'],
    run: ({ clear }) => clear(),
  },
};

function findCommand(name: string): TerminalCommand | undefined {
  const key = name.toLowerCase();
  if (commands[key]) return commands[key];
  return Object.values(commands).find((cmd) => cmd.aliases?.includes(key));
}

const HISTORY_LIMIT = 50;
const history: string[] = [];

export function initTerminal(root: HTMLElement) {
  if (root.dataset.terminalReady) return;
  root.dataset.terminalReady = 'true';

  const output = root.querySelector<HTMLOListElement>('[data-terminal-output]');
  const input = root.querySelector<HTMLInputElement>('[data-terminal-input]');
  const mirror = root.querySelector<HTMLElement>('[data-terminal-mirror]');
  if (!output || !input || !mirror) return;

  const placeholder = input.placeholder;
  let historyIndex = history.length;
  let draft = '';

  const scrollToBottom = () => { root.scrollTop = root.scrollHeight; };

  const print = (text: string, tone: OutputTone = 'default') => {
    const line = document.createElement('li');
    line.className = 'console-output';
    if (tone !== 'default') line.classList.add(`console-${tone}`);
    line.textContent = text;
    output.append(line);
  };

  const echoCommand = (text: string) => {
    const line = document.createElement('li');
    line.className = 'console-output';
    const prompt = document.createElement('span');
    prompt.className = 'console-prompt';
    prompt.textContent = '>';
    line.append(prompt, ` ${text}`);
    output.append(line);
  };

  const render = () => {
    mirror.replaceChildren();
    const focused = document.activeElement === input;
    const value = input.value;
    const caret = document.createElement('span');
    caret.className = 'console-caret';

    if (!value && !focused) {
      mirror.append(placeholder, caret);
      mirror.scrollLeft = 0;
      return;
    }

    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? start;

    if (start !== end) {
      const selected = document.createElement('span');
      selected.className = 'console-selection';
      selected.textContent = value.slice(start, end);
      mirror.append(value.slice(0, start), selected, value.slice(end));
      return;
    }

    caret.classList.add('console-caret-char');
    caret.textContent = value[start] ?? '\u00a0';
    mirror.append(value.slice(0, start), caret, value.slice(start + 1));

    // Keep the cursor in view when the command is wider than the console.
    const caretLeft = caret.offsetLeft - mirror.offsetLeft;
    if (caretLeft < mirror.scrollLeft) mirror.scrollLeft = caretLeft;
    else if (caretLeft + caret.offsetWidth > mirror.scrollLeft + mirror.clientWidth) {
      mirror.scrollLeft = caretLeft + caret.offsetWidth - mirror.clientWidth;
    }
  };

  const run = async (raw: string) => {
    const trimmed = raw.trim();
    echoCommand(raw);
    if (!trimmed) return;

    if (history[history.length - 1] !== trimmed) history.push(trimmed);
    if (history.length > HISTORY_LIMIT) history.shift();

    const [name, ...args] = trimmed.split(/\s+/);
    const command = findCommand(name);
    if (!command) {
      print(`'${name}' is not recognized as a command. Type 'help' for a list of commands.`, 'denied');
      return;
    }

    try {
      await command.run({
        args,
        raw: trimmed,
        print,
        clear: () => output.replaceChildren(),
        open: (href) => { void navigate(href); },
        history,
      });
    } catch (error) {
      print(`${name}: process terminated unexpectedly`, 'denied');
      console.error(error);
    }
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const value = input.value;
      input.value = '';
      draft = '';
      const done = run(value);
      historyIndex = history.length;
      render();
      scrollToBottom();
      void done.then(scrollToBottom);
      return;
    }

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (!history.length) return;
      event.preventDefault();
      if (historyIndex === history.length) draft = input.value;
      historyIndex = event.key === 'ArrowUp'
        ? Math.max(0, historyIndex - 1)
        : Math.min(history.length, historyIndex + 1);
      input.value = historyIndex === history.length ? draft : history[historyIndex];
      input.setSelectionRange(input.value.length, input.value.length);
      render();
      return;
    }

    if (event.key === 'l' && event.ctrlKey) {
      event.preventDefault();
      output.replaceChildren();
    }
  });

  for (const type of ['input', 'focus', 'blur', 'select', 'selectionchange', 'keyup', 'mouseup']) {
    input.addEventListener(type, render);
  }

  root.addEventListener('click', () => {
    if (window.getSelection()?.isCollapsed === false) return;
    if (document.activeElement !== input) input.focus({ preventScroll: true });
  });

  render();
}
