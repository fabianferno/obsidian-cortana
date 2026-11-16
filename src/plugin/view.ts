// plugin/view.ts - the side panel: Cortana's ring, transcript, mic button, text box.

import { ItemView, setIcon, type WorkspaceLeaf } from 'obsidian';
import type CortanaPlugin from './main.js';
import { NAME, USER_TITLE } from '../brand.js';
import { describeSource, type Entry } from './transcript.js';
import type { VoiceState } from '../voice/session.js';
import { describeChange, type NoteChange } from '../agent/changes.js';

const CHANGE_ICONS: Record<NoteChange['kind'], string> = {
  created: 'file-plus', updated: 'file-pen', moved: 'folder-input', asked: 'circle-help', trashed: 'trash-2', deleted: 'trash-2',
};

export const VIEW_TYPE = 'cortana-panel';

const STATE_LABEL: Record<VoiceState, string> = {
  idle: 'Ready',
  listening: 'Listening',
  hearing: 'Hearing you',
  transcribing: 'Transcribing',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

export class CortanaView extends ItemView {
  private listEl!: HTMLElement;
  private stateEl!: HTMLElement;
  /** Small ring in the top bar, shown once the conversation has started. */
  private miniOrb!: HTMLButtonElement;
  /** Big ring on the empty panel. */
  private bigOrb?: HTMLButtonElement;
  private micBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private input!: HTMLTextAreaElement;
  private noticeEl!: HTMLElement;
  private rendered = new Map<number, HTMLElement>();
  private unsubscribe?: () => void;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CortanaPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return NAME;
  }

  getIcon(): string {
    return 'audio-lines';
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('cortana-root');

    const header = root.createDiv('cortana-header');
    this.miniOrb = this.createOrb(header, 'is-mini');
    header.createDiv({ cls: 'cortana-title', text: this.getDisplayText() });
    this.stateEl = header.createDiv('cortana-state');
    const menu = header.createEl('button', { cls: 'clickable-icon cortana-icon-btn', attr: { 'aria-label': 'New conversation' } });
    setIcon(menu, 'rotate-ccw');
    menu.onclick = () => void this.plugin.newConversation();

    this.noticeEl = root.createDiv('cortana-notice');
    this.listEl = root.createDiv('cortana-list');

    const footer = root.createDiv('cortana-footer');
    this.micBtn = footer.createEl('button', { cls: 'cortana-mic', attr: { 'aria-label': 'Talk (toggle listening)' } });
    this.micBtn.onclick = () => void this.plugin.toggleListening();
    this.stopBtn = footer.createEl('button', { cls: 'clickable-icon cortana-icon-btn cortana-stop', attr: { 'aria-label': 'Stop' } });
    setIcon(this.stopBtn, 'square');
    this.stopBtn.onclick = () => this.plugin.interrupt();
    this.input = footer.createEl('textarea', { cls: 'cortana-input', attr: { rows: '1', placeholder: 'Type, or press the mic and talk' } });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const text = this.input.value;
        this.input.value = '';
        void this.plugin.sendText(text);
      }
    });

    this.unsubscribe = this.plugin.transcript.subscribe((changed) => this.render(changed));
    this.render();
    if (this.plugin.settings.listenOnOpen && !this.plugin.isListening) void this.plugin.toggleListening();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.rendered.clear();
  }

  setNotice(text: string): void {
    if (!this.noticeEl) return;
    this.noticeEl.setText(text);
    this.noticeEl.toggleClass('is-visible', !!text);
  }

  private render(changed?: Entry): void {
    const t = this.plugin.transcript;
    const state = t.voiceState;
    this.stateEl.setText(STATE_LABEL[state]);
    this.stateEl.dataset.state = state;
    const listening = this.plugin.isListening;
    this.micBtn.empty();
    setIcon(this.micBtn, listening ? 'mic' : 'mic-off');
    this.micBtn.toggleClass('is-on', listening);
    this.micBtn.dataset.state = state;
    this.stopBtn.toggleClass('is-visible', state === 'thinking' || state === 'speaking' || state === 'transcribing');

    if (changed && this.rendered.has(changed.id)) {
      this.fill(this.rendered.get(changed.id)!, changed);
    } else {
      // Structural change: sync the list.
      const ids = new Set(t.entries.map(e => e.id));
      for (const [id, el] of this.rendered) {
        if (!ids.has(id)) {
          el.remove();
          this.rendered.delete(id);
        }
      }
      for (const e of t.entries) {
        let el = this.rendered.get(e.id);
        if (!el) {
          el = this.listEl.createDiv();
          this.rendered.set(e.id, el);
        }
        this.fill(el, e);
      }
      if (t.entries.length === 0) this.renderEmpty();
      else {
        this.listEl.querySelector('.cortana-empty')?.remove();
        this.bigOrb = undefined;
      }
      this.contentEl.toggleClass('is-empty', t.entries.length === 0);
    }
    for (const orb of [this.miniOrb, this.bigOrb]) {
      if (!orb) continue;
      orb.dataset.state = state;
      orb.toggleClass('is-on', listening);
    }
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  private renderEmpty(): void {
    if (this.listEl.querySelector('.cortana-empty')) return;
    const empty = this.listEl.createDiv('cortana-empty');
    this.bigOrb = this.createOrb(empty, 'is-big');
    empty.createDiv({ cls: 'cortana-greeting', text: `Hi ${USER_TITLE}, I'm ${NAME}.` });
    empty.createDiv({ text: 'Tap the circle or the mic and talk, or type below.' });
    empty.createDiv({ cls: 'cortana-empty-hint', text: 'Try: "What should I work on?", "Add call the bank to To Do", "Summarize my notes on the garden project".' });
  }

  /** Cortana's circle. Its motion follows the voice state; clicking it toggles listening. */
  private createOrb(parent: HTMLElement, size: 'is-mini' | 'is-big'): HTMLButtonElement {
    const orb = parent.createEl('button', { cls: `cortana-orb ${size}`, attr: { 'aria-label': 'Talk (toggle listening)' } });
    orb.createDiv('cortana-orb-outer');
    orb.createDiv('cortana-orb-inner');
    orb.onclick = () => void this.plugin.toggleListening();
    return orb;
  }

  private fill(el: HTMLElement, e: Entry): void {
    el.className = `cortana-msg cortana-${e.role}${e.source ? ' cortana-proactive' : ''}${e.done ? '' : ' is-live'}`;
    el.empty();
    const label = describeSource(e.source);
    if (label) el.createDiv({ cls: 'cortana-label', text: label });
    if (e.text) el.createDiv({ cls: 'cortana-text', text: e.text });
    if (!e.done && !e.text) el.createDiv({ cls: 'cortana-typing', text: e.status ?? 'Thinking...' });
    else if (!e.done && e.status) el.createDiv({ cls: 'cortana-status', text: e.status });
    if (e.changes?.length) this.renderChanges(el, e.changes);
    if (e.error) el.createDiv({ cls: 'cortana-error-text', text: e.error });
    if (e.interrupted) el.createDiv({ cls: 'cortana-status', text: 'Stopped' });
  }

  /** One chip per note or file the turn touched; click to open it. */
  private renderChanges(el: HTMLElement, changes: NoteChange[]): void {
    const row = el.createDiv('cortana-changes');
    for (const c of changes) {
      const target = c.kind === 'moved' ? c.to ?? c.path : c.path;
      const gone = c.kind === 'trashed' || c.kind === 'deleted';
      const chip = row.createEl(gone ? 'span' : 'a', { cls: `cortana-change cortana-change-${c.kind}`, attr: { 'aria-label': target } });
      setIcon(chip.createSpan('cortana-change-icon'), CHANGE_ICONS[c.kind]);
      chip.createSpan({ text: describeChange(c) });
      if (!gone) {
        chip.onClickEvent((ev: MouseEvent) => {
          ev.preventDefault();
          void this.app.workspace.openLinkText(target, '', ev.metaKey || ev.ctrlKey);
        });
      }
    }
  }
}
