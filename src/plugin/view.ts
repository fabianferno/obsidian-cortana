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

/** Streaming text: a new word every STREAM_GAP ms, never more than STREAM_MAX_LAG behind. */
const STREAM_GAP = 60;
const STREAM_MAX_LAG = 900;

/** Sets text that shimmers while `active` (the ::before layer reads data-text). */
function setShimmer(el: HTMLElement, text: string, active: boolean): void {
  el.setText(text);
  el.dataset.text = text;
  el.toggleClass('cortana-shimmer', active);
}

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
  /** Words already shown per reply, so only new words stream in. */
  private streamed = new WeakMap<HTMLElement, { tokens: string[]; nextAt: number }>();
  /** False during the first render, so history appears at once instead of streaming. */
  private live = false;
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

    // One rounded composer: the text box with the stop and mic buttons inside it.
    const footer = root.createDiv('cortana-footer');
    const composer = footer.createDiv('cortana-composer');
    this.input = composer.createEl('textarea', { cls: 'cortana-input', attr: { rows: '1', placeholder: `Message ${NAME}` } });
    this.stopBtn = composer.createEl('button', { cls: 'cortana-composer-btn cortana-stop', attr: { 'aria-label': 'Stop' } });
    setIcon(this.stopBtn, 'square');
    this.stopBtn.onclick = () => this.plugin.interrupt();
    this.micBtn = composer.createEl('button', { cls: 'cortana-composer-btn cortana-mic', attr: { 'aria-label': 'Talk (toggle listening)' } });
    this.micBtn.onclick = () => void this.plugin.toggleListening();
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
    this.live = true;
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
    setShimmer(this.stateEl, STATE_LABEL[state], state !== 'idle');
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
    // Keep the text element across updates so streamed words animate in only once.
    const textEl = el.querySelector<HTMLElement>(':scope > .cortana-text');
    textEl?.detach();
    el.empty();
    const label = describeSource(e.source);
    if (label) el.createDiv({ cls: 'cortana-label', text: label });
    if (e.text) {
      const target = textEl ?? createDiv('cortana-text');
      el.appendChild(target);
      if (e.role === 'agent') this.streamText(target, e.text);
      else target.setText(e.text);
    }
    if (!e.done && !e.text) setShimmer(el.createDiv('cortana-typing'), e.status ?? 'Thinking...', true);
    else if (!e.done && e.status) setShimmer(el.createDiv('cortana-status'), e.status, true);
    if (e.changes?.length) this.renderChanges(el, e.changes);
    if (e.error) el.createDiv({ cls: 'cortana-error-text', text: e.error });
    if (e.interrupted) el.createDiv({ cls: 'cortana-status', text: 'Stopped' });
  }

  /**
   * Shows a reply's text, letting only the words that are new since the last
   * update resolve in (opacity plus a soft blur), one every STREAM_GAP ms.
   * The backlog is capped so a fast stream never lags far behind.
   */
  private streamText(el: HTMLElement, text: string): void {
    const tokens = text.split(/(\s+)/).filter(t => t !== '');
    const prev = this.streamed.get(el) ?? { tokens: [], nextAt: 0 };
    const extends_ = prev.tokens.length <= tokens.length
      && prev.tokens.every((t, i) => i === prev.tokens.length - 1 ? tokens[i].startsWith(t) : t === tokens[i]);
    if (!this.live || !extends_) {
      // History, or text that was rewritten rather than extended: show it as is.
      el.empty();
      for (const t of tokens) this.appendToken(el, t, null);
      this.streamed.set(el, { tokens, nextAt: 0 });
      return;
    }
    // The last word may have grown since the last chunk (it was cut mid-word).
    const kids = el.childNodes;
    if (prev.tokens.length > 0 && kids.length > 0) kids[kids.length - 1].textContent = tokens[prev.tokens.length - 1];
    const now = performance.now();
    let at = Math.max(now, prev.nextAt);
    for (const t of tokens.slice(prev.tokens.length)) {
      const delay = Math.min(at - now, STREAM_MAX_LAG);
      this.appendToken(el, t, /\s/.test(t) ? null : delay);
      if (!/\s/.test(t)) at = now + delay + STREAM_GAP;
    }
    this.streamed.set(el, { tokens, nextAt: at });
  }

  /** A word as an animated span (delay in ms), or plain text (whitespace, history). */
  private appendToken(el: HTMLElement, token: string, delay: number | null): void {
    if (delay === null) {
      el.appendText(token);
      return;
    }
    const w = el.createSpan({ cls: 'cortana-stream-w', text: token });
    w.setCssProps({ '--cortana-word-delay': `${Math.round(delay)}ms` });
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
