import { Prop } from './prop.ts';
import type { PropEditor } from './propEditor.ts';
import type { Point } from './room.ts';

const COPIED_MS = 1500;

/** The debug prop-editor side panel: mirrors the PropEditor state and forwards its buttons. */
export class EditorPanel {
  editor: PropEditor | null = null;
  private copyTimer = 0;
  private readonly cursor: HTMLElement | null;
  private readonly snippet: HTMLTextAreaElement | null;
  private readonly copy: HTMLButtonElement | null;

  constructor(private readonly panel: HTMLElement | null, root: HTMLElement) {
    this.cursor = root.querySelector<HTMLElement>('[data-editor-cursor]');
    this.snippet = root.querySelector<HTMLTextAreaElement>('[data-editor-snippet]');
    this.copy = root.querySelector<HTMLButtonElement>('[data-editor-copy]');
    panel?.addEventListener('click', this.onClick);
  }

  get active() {
    return !!this.editor?.active;
  }

  /** Opens or closes the editor; returns whether it is now active. */
  toggle(): boolean {
    if (!this.editor || !this.panel) return false;
    this.editor.active = !this.editor.active;
    this.panel.hidden = !this.editor.active;
    this.render();
    return this.editor.active;
  }

  showCursor(point: Point | null) {
    if (!this.cursor) return;
    this.cursor.textContent = point ? `Cursor: ${point.x}, ${point.y}` : 'Cursor: –';
  }

  readonly render = () => {
    const { editor, panel } = this;
    if (!editor || !panel) return;
    const { room, selected, selectedDoor, placing } = editor;
    const prop = selected instanceof Prop ? selected : null;
    const edited = editor.isEdited();
    panel.querySelector('[data-editor-room]')!.textContent = `${room.camera} · ${room.name}${edited ? ' · unsaved changes' : ''}`;
    panel.querySelector('[data-editor-file]')!.textContent = `src/sim_assets/rooms/${room.templateId ?? room.id}/room.json`;
    panel.querySelector('[data-editor-selected]')!.textContent = placing
      ? `Click the feed to place: ${placing}`
      : selectedDoor
        ? `${selectedDoor.door.id} ${selectedDoor.part} · clearance ${selectedDoor.state.clearance}` +
          `${selectedDoor.state.isBroken(selectedDoor.part) ? ' · broken' : ''} · live only, not saved`
      : selected
        ? `${selected.type} · x ${selected.x}, y ${selected.y}${selected.flip ? ' · flipped' : ''}` +
          `${prop?.start?.broken ? ' · broken' : ''}${prop?.start?.on === false ? ' · starts off' : ''}`
        : 'Nothing selected';
    panel.querySelector<HTMLButtonElement>('[data-editor-flip]')!.disabled = !selected;
    const broken = panel.querySelector<HTMLButtonElement>('[data-editor-broken]')!;
    broken.disabled = !prop?.breakable && !selectedDoor;
    broken.setAttribute('aria-pressed', String(selectedDoor ? selectedDoor.state.isBroken(selectedDoor.part) : !!prop?.start?.broken));
    const off = panel.querySelector<HTMLButtonElement>('[data-editor-off]')!;
    off.disabled = !prop?.switchable;
    off.setAttribute('aria-pressed', String(prop?.start?.on === false));
    panel.querySelector<HTMLButtonElement>('[data-editor-delete]')!.disabled = !selected;
    for (const button of panel.querySelectorAll<HTMLElement>('[data-editor-add]')) {
      button.setAttribute('aria-pressed', String(button.dataset.editorAdd === placing));
    }
    if (this.snippet) this.snippet.value = editor.snippet();
  };

  dispose() {
    window.clearTimeout(this.copyTimer);
    this.panel?.removeEventListener('click', this.onClick);
  }

  private readonly onClick = (event: MouseEvent) => {
    const editor = this.editor;
    if (!editor) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>('button');
    if (!target) return;
    if (target.dataset.editorAdd) editor.add(target.dataset.editorAdd);
    else if (target.hasAttribute('data-editor-flip')) editor.flip();
    else if (target.hasAttribute('data-editor-broken')) editor.toggleBroken();
    else if (target.hasAttribute('data-editor-off')) editor.toggleOff();
    else if (target.hasAttribute('data-editor-delete')) editor.remove();
    else if (target.hasAttribute('data-editor-reset')) editor.reset();
    else if (target.hasAttribute('data-editor-copy')) this.copySnippet();
  };

  private copySnippet() {
    const { snippet, copy } = this;
    if (!snippet) return;
    const done = () => {
      if (!copy) return;
      copy.textContent = 'Copied!';
      window.clearTimeout(this.copyTimer);
      this.copyTimer = window.setTimeout(() => { copy.textContent = 'Copy'; }, COPIED_MS);
    };
    navigator.clipboard?.writeText(snippet.value).then(done, () => {
      // Clipboard access can be blocked; leave the text selected for Cmd/Ctrl+C.
      snippet.select();
    });
  }
}
