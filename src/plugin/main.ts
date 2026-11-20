// plugin/main.ts - the Obsidian plugin: wires the agent, the engine, voice and the panel.

import { FileSystemAdapter, Notice, Platform, Plugin, TFile, normalizePath, requestUrl } from 'obsidian';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import WORKER_SOURCE from 'virtual:voice-worker';
import ORT_GLUE from 'virtual:ort-glue';
import { Agent, type AgentSettings } from '../agent/agent.js';
import type { VaultOps } from '../vault/ops.js';
import { Store, type StoreData } from '../store/store.js';
import { boardFile, getLayout, setLayout, setVaultPath } from '../config/paths.js';
import { checkEngine, createEngine, ENGINE_INFO, type EngineSession } from '../engines/index.js';
import { shellEnv } from '../engines/shell-env.js';
import { VoiceSession } from '../voice/session.js';
import { Player } from '../voice/player.js';
import { Mic } from '../voice/mic.js';
import { ElevenLabsTts, SarvamStt, SarvamTts, SonioxStt, SonioxTts, elevenLabsReadsCues, sonioxReadsCues } from '../voice/cloud.js';
import type { SpeechStyle } from '../brain/prompt-builder.js';
import { LocalVoiceWorker, LocalWhisper } from '../voice/local/client.js';
import { SystemTts } from '../voice/system.js';
import { cacheRoot, ensureWasm } from '../voice/local/runtime.js';
import { assistantName } from '../brand.js';
import { removeOldKokoroModels } from '../voice/local/cleanup.js';
import { createLogger } from '../utils/logger.js';
import type { Http } from '../voice/http.js';
import { elevenLabsVoices, sonioxVoices, type VoiceOption } from '../voice/voices.js';
import type { SpeechToText, TextToSpeech } from '../voice/types.js';
import { Transcript } from './transcript.js';
import { GlobalShortcut } from './global-shortcut.js';
import { WorkspaceWatcher } from './workspace-watcher.js';
import { playCue } from '../voice/cue.js';
import { VIEW_TYPE, CortanaView } from './view.js';
import { DEFAULT_SETTINGS, CortanaSettingTab, mergeSettings, parseExtraArgs, type CortanaSettings } from './settings.js';
import { McpHandler, newToken, startMcpServer, type RunningServer } from '../mcp/server.js';
import { appendAgentLog } from '../vault/agent-log.js';
import { createBoard } from '../vault/writer.js';
import { localDate } from '../checkins/scheduler.js';
import type { NoteChange } from '../agent/changes.js';

/** The bearer token other AIs use, kept in Obsidian's secret storage. */
const MCP_TOKEN_SECRET = 'cortana-mcp-token';

declare const ORT_WASM_SHA256: string;
declare const TRANSFORMERS_VERSION: string;

/** The shortcut's mic closes if nothing is said for this long. */
const ONE_SHOT_SILENCE_MS = 10000;

/** Sarvam's Indian languages by code prefix (en-IN needs no script rules). */
const INDIC_LANGUAGES: Record<string, string> = {
  hi: 'Hindi', bn: 'Bengali', ta: 'Tamil', te: 'Telugu', kn: 'Kannada', ml: 'Malayalam',
  mr: 'Marathi', gu: 'Gujarati', pa: 'Punjabi', od: 'Odia', or: 'Odia',
};

export default class CortanaPlugin extends Plugin {
  settings: CortanaSettings = DEFAULT_SETTINGS;
  transcript = new Transcript();
  private vaultPath = '';
  private agent?: Agent;
  private store?: Store;
  private env?: NodeJS.ProcessEnv;
  private session?: VoiceSession;
  /** Set in onunload; startAgent checks it after each await so a disabled plugin starts nothing. */
  private unloaded = false;
  private player = new Player();
  private mic = new Mic();
  private watcher?: WorkspaceWatcher;
  private shortcut = new GlobalShortcut(() => void this.talkFromAnywhere());
  /** Listening for one question from the system-wide shortcut; the mic closes after it. */
  private oneShot = false;
  /** Why the shortcut from the settings is not registered, or ''. */
  shortcutError = '';
  private oneShotTimer?: number;
  private localWorker?: LocalVoiceWorker;
  private saveTimer?: number;
  private pendingState?: StoreData;
  private stateFile = '';
  private mcp?: RunningServer;
  /** Why the server for other AIs is not running though turned on, or ''. */
  mcpError = '';
  /** Setup warnings already shown, keyed by the path they were about, so each shows once. */
  private warned: string[] = [];

  async onload(): Promise<void> {
    const saved = (await this.loadData()) as { settings?: Partial<CortanaSettings>; warned?: unknown } | null;
    this.settings = mergeSettings(saved?.settings);
    this.warned = Array.isArray(saved?.warned) ? saved.warned.filter((w): w is string => typeof w === 'string') : [];
    if (!Platform.isDesktopApp || !(this.app.vault.adapter instanceof FileSystemAdapter)) {
      new Notice('Cortana needs Obsidian on desktop.');
      return;
    }
    this.vaultPath = this.app.vault.adapter.getBasePath();
    setVaultPath(this.vaultPath);
    setLayout(this.settings.layout);

    this.registerView(VIEW_TYPE, (leaf) => new CortanaView(leaf, this));
    this.addRibbonIcon('audio-lines', 'Open Cortana', () => void this.openPanel());
    this.addSettingTab(new CortanaSettingTab(this.app, this));

    this.addCommand({ id: 'open-panel', name: 'Open panel', callback: () => void this.openPanel() });
    this.addCommand({ id: 'toggle-listening', name: 'Talk (start or stop listening)', callback: () => void this.toggleListening() });
    this.addCommand({ id: 'stop', name: 'Stop speaking', callback: () => this.interrupt() });
    this.addCommand({ id: 'new-conversation', name: 'New conversation', callback: () => void this.newConversation() });
    this.addCommand({ id: 'create-board', name: 'Create a board', callback: () => void this.makeBoard() });

    const shortcutError = this.applyGlobalShortcut();
    if (shortcutError) new Notice(`Cortana shortcut: ${shortcutError} Change it in the plugin settings.`, 10000);

    this.transcript.onProactive = (text, source) => {
      // What other AIs file shows in the panel only; a popup per write would be noise.
      if (!this.panelVisible() && source !== 'outside-ai') new Notice(text, 15000);
    };

    // Engine lookup and agent start can take a moment (login shell, files):
    // do it once the workspace is ready so Obsidian's startup is not delayed.
    this.app.workspace.onLayoutReady(() => {
      this.watcher = new WorkspaceWatcher(this.app);
      this.watcher.register(this);
      const { boardPath, dailyFolder } = getLayout();
      if (!existsSync(boardFile(this.vaultPath))) {
        this.warnOnce(`board:${boardPath}`, `Cortana: no board at "${boardPath}". Ask Cortana to make one, run "Cortana: Create a board", or set the path of yours in the plugin settings.`);
      }
      if (dailyFolder && !existsSync(path.join(this.vaultPath, dailyFolder))) {
        this.warnOnce(`daily:${dailyFolder}`, `Cortana: no daily notes folder at "${dailyFolder}", so the agent cannot keep out of your daily notes. Fix it in the plugin settings.`);
      }
      void this.startAgent();
      // Free the space Kokoro (0.1.x) used; harmless when there is nothing to remove.
      removeOldKokoroModels().then(
        (n) => { if (n) createLogger('voice').info(`Removed ${n} old Kokoro model files from the cache`); },
        () => undefined,
      );
    });
  }

  onunload(): void {
    this.unloaded = true;
    this.shortcut.clear();
    this.clearOneShot();
    this.agent?.stop();
    void this.mcp?.close();
    this.mic.stop();
    this.player.dispose();
    this.localWorker?.dispose();
    this.flushState();
  }

  // --- state ---

  private loadState(): Store {
    const id = createHash('sha1').update(this.vaultPath).digest('hex').slice(0, 12);
    this.stateFile = path.join(cacheRoot(), 'state', `${id}.json`);
    let initial: Partial<StoreData> | null = null;
    try {
      if (existsSync(this.stateFile)) initial = JSON.parse(readFileSync(this.stateFile, 'utf-8')) as Partial<StoreData>;
    } catch (err) {
      console.error('[cortana] Could not read state, starting fresh', err);
    }
    return new Store(initial, (data) => {
      this.pendingState = data;
      window.clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => this.flushState(), 1000);
    });
  }

  /** Agent state lives outside the vault so obsidian-git does not commit it. */
  private flushState(): void {
    if (!this.pendingState || !this.stateFile) return;
    try {
      mkdirSync(path.dirname(this.stateFile), { recursive: true });
      writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(this.pendingState));
      renameSync(`${this.stateFile}.tmp`, this.stateFile);
      this.pendingState = undefined;
    } catch (err) {
      console.error('[cortana] Could not save state', err);
    }
  }

  // --- agent ---

  private agentSettings(): AgentSettings {
    const s = this.settings;
    return {
      checkpointTimes: s.checkpointTimes,
      greetOnOpen: s.greetOnOpen,
      pulses: s.pulses,
      capture: s.capture,
      graduate: s.graduate,
      graduatePerDay: s.graduatePerDay,
      speech: this.speechStyle(),
      name: s.assistantName,
      userTitle: s.userTitle,
    };
  }

  /** What the chosen voice can do, for the prompt's speech rules. */
  private speechStyle(): SpeechStyle | undefined {
    const s = this.settings;
    const cues = (s.tts === 'soniox' && sonioxReadsCues(s.sonioxTtsModel))
      || (s.tts === 'elevenlabs' && elevenLabsReadsCues(s.elevenlabsModel));
    const indicLanguage = s.tts === 'sarvam' ? INDIC_LANGUAGES[s.sarvamTtsLanguage.trim().slice(0, 2).toLowerCase()] : undefined;
    return cues || indicLanguage ? { cues, ...(indicLanguage ? { indicLanguage } : {}) } : undefined;
  }

  /**
   * Every vault write goes through Obsidian: edits with vault.process (atomic, so an
   * open note keeps its keystrokes), moves so links follow, deletions to the trash.
   */
  private vaultOps(): VaultOps {
    const vault = this.app.vault;
    const file = (rel: string): TFile => {
      const f = vault.getAbstractFileByPath(rel);
      if (!(f instanceof TFile)) throw new Error(`No note at ${rel}`);
      return f;
    };
    const ensureFolder = async (folder: string) => {
      if (folder === '.' || folder === '' || vault.getAbstractFileByPath(folder)) return;
      await ensureFolder(path.posix.dirname(folder));
      try {
        await vault.createFolder(folder);
      } catch (err) {
        if (!vault.getAbstractFileByPath(folder)) throw err;
      }
    };
    return {
      move: async (from, to) => {
        await ensureFolder(path.posix.dirname(to));
        await this.app.fileManager.renameFile(file(from), to);
      },
      trash: async (rel) => this.app.fileManager.trashFile(file(rel)),
      process: async (rel, edit) => {
        const target = normalizePath(rel);
        const existing = vault.getAbstractFileByPath(target);
        if (existing instanceof TFile) {
          await vault.process(existing, edit);
          return;
        }
        await ensureFolder(path.posix.dirname(target));
        await vault.create(target, edit(''));
      },
    };
  }

  private engineFactory() {
    const s = this.settings;
    return (systemPrompt: string, opts: { readOnly?: boolean } = {}): EngineSession => createEngine(s.engine, {
      bin: s.engineBin[s.engine] || ENGINE_INFO[s.engine].bin,
      cwd: this.vaultPath,
      model: s.model || undefined,
      permissions: s.permissions,
      extraArgs: parseExtraArgs(s.extraArgs),
      systemPrompt,
      env: this.env,
      denyPaths: [s.layout.dailyFolder],
      protectPaths: [getLayout().boardPath, s.layout.agentFolder],
      readOnly: opts.readOnly,
    });
  }

  private async startAgent(): Promise<void> {
    try {
      this.env = await shellEnv();
      if (this.unloaded) return;
      this.store = this.loadState();
      // Other AIs need only the vault and the state, not the engine.
      await this.applyMcp();
      this.session = new VoiceSession(
        { handleUserMessage: (t, o) => this.requireAgent().handleUserMessage(t, o), interrupt: () => this.agent?.interrupt() },
        null, null, this.player, this.transcript, this.voiceOptions(),
      );
      this.session.onVad = (type) => this.onOneShotVad(type);
      this.rebuildVoice();
      this.agent = new Agent(this.vaultPath, this.store, this.engineFactory(), this.agentSettings(), (m) => {
        void this.session?.proactive(m.text, m.source, { changes: m.changes, speak: m.speak });
      }, this.vaultOps(), () => (this.settings.seeWorkspace ? this.watcher?.snapshot(getLayout()) ?? null : null));
      await this.agent.start();
      if (this.unloaded) this.agent.stop();
    } catch (err) {
      console.error('[cortana] Failed to start', err);
      new Notice(`Cortana could not start: ${(err as Error).message}`, 10000);
    }
  }

  private requireAgent(): Agent {
    if (!this.agent) throw new Error('The agent is still starting. Try again in a moment.');
    return this.agent;
  }

  async checkEngine(): Promise<string> {
    const s = this.settings;
    this.env ??= await shellEnv();
    return checkEngine(s.engine, s.engineBin[s.engine] || ENGINE_INFO[s.engine].bin, this.env);
  }

  // --- voice ---

  private voiceOptions() {
    const s = this.settings;
    return { speak: s.tts !== 'off', speakProactive: s.speakProactive, bargeIn: s.bargeIn };
  }

  private http: Http = async (req) => {
    const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, contentType: req.contentType, throw: false });
    return { status: res.status, text: res.text, arrayBuffer: res.arrayBuffer };
  };

  /** The voices the user's key can use, for the settings picker. Throws with a readable reason. */
  async listVoices(provider: 'elevenlabs' | 'soniox'): Promise<VoiceOption[]> {
    const s = this.settings;
    if (provider === 'elevenlabs') return elevenLabsVoices(this.http, this.secret(s.elevenlabsSecret, 'ElevenLabs'));
    return sonioxVoices(this.http, this.secret(s.sonioxSecret, 'Soniox'), s.sonioxTtsModel);
  }

  private secret(name: string, label: string): string {
    const value = name ? this.app.secretStorage.getSecret(name) : null;
    if (!value) throw new Error(`Set your ${label} API key in the Cortana settings.`);
    return value;
  }

  private worker(): LocalVoiceWorker {
    this.localWorker ??= new LocalVoiceWorker({
      workerSource: WORKER_SOURCE,
      runtime: async () => {
        const wasm = await ensureWasm(
          { baseUrl: `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/`, expectedSha256: ORT_WASM_SHA256 },
          async (url) => (await requestUrl({ url })).arrayBuffer,
          undefined,
          (msg) => this.setNotice(msg),
        );
        this.setNotice('');
        return {
          mjs: URL.createObjectURL(new Blob([ORT_GLUE], { type: 'text/javascript' })),
          wasm: URL.createObjectURL(new Blob([wasm as Uint8Array<ArrayBuffer>], { type: 'application/wasm' })),
        };
      },
      onProgress: (msg) => this.setNotice(msg),
    });
    return this.localWorker;
  }

  private buildStt(): SpeechToText | null {
    const s = this.settings;
    try {
      switch (s.stt) {
        case 'local': return new LocalWhisper(this.worker(), s.localSttModel);
        case 'sarvam': return new SarvamStt(this.http, this.secret(s.sarvamSecret, 'Sarvam'), { language: s.sarvamSttLanguage });
        case 'soniox': return new SonioxStt(this.secret(s.sonioxSecret, 'Soniox'), { model: s.sonioxSttModel, language: s.sonioxLanguage });
      }
    } catch (err) {
      this.transcript.error((err as Error).message);
      return null;
    }
  }

  private buildTts(): TextToSpeech | null {
    const s = this.settings;
    try {
      switch (s.tts) {
        case 'off': return null;
        case 'system': return new SystemTts(s.systemVoice, s.speechRate);
        case 'elevenlabs': return new ElevenLabsTts(this.http, this.secret(s.elevenlabsSecret, 'ElevenLabs'), {
          voice: s.elevenlabsVoice, model: s.elevenlabsModel,
        });
        case 'sarvam': return new SarvamTts(this.http, this.secret(s.sarvamSecret, 'Sarvam'), {
          model: s.sarvamTtsModel, speaker: s.sarvamTtsSpeaker || undefined, language: s.sarvamTtsLanguage,
        });
        case 'soniox': return new SonioxTts(this.http, this.secret(s.sonioxSecret, 'Soniox'), {
          model: s.sonioxTtsModel, voice: s.sonioxTtsVoice, language: s.sonioxLanguage,
        });
      }
    } catch (err) {
      this.transcript.error((err as Error).message);
      return null;
    }
  }

  private stt: SpeechToText | null = null;
  private tts: TextToSpeech | null = null;
  private warmed = false;

  private rebuildVoice(): void {
    if (this.settings.stt !== 'local') {
      this.localWorker?.dispose();
      this.localWorker = undefined;
    }
    this.stt = this.buildStt();
    this.tts = this.buildTts();
    this.warmed = false;
    this.session?.setProviders(this.stt, this.tts);
    this.session?.setOptions(this.voiceOptions());
    this.agent?.setSpeechStyle(this.speechStyle());
  }

  /** Loads local models ahead of the first turn (downloads them the first time). */
  private warmup(): void {
    if (this.warmed) return;
    this.warmed = true;
    for (const p of [this.stt, this.tts]) {
      if (!p?.warmup) continue;
      this.setNotice(`Loading ${p.label}...`);
      p.warmup().then(
        () => this.setNotice(''),
        (err) => {
          this.warmed = false;
          this.setNotice('');
          this.transcript.error(`Could not load ${p.label}: ${(err as Error).message}`);
        },
      );
    }
  }

  get isListening(): boolean {
    return this.mic.active;
  }

  /** `background`: the system-wide shortcut. The panel is not revealed, since that would pull Obsidian to the front. */
  async toggleListening(opts: { background?: boolean } = {}): Promise<void> {
    if (!this.session) return void new Notice('Cortana is still starting.');
    if (this.mic.active) {
      if (this.oneShot) playCue('stop');
      this.clearOneShot();
      this.mic.stop();
      this.session.setListening(false);
      return;
    }
    if (!this.stt) {
      this.stt = this.buildStt();
      this.session.setProviders(this.stt, this.tts);
      if (!this.stt) return;
    }
    if (!opts.background) await this.openPanel();
    this.warmup();
    try {
      this.mic.onFrame = (f) => this.session?.onFrame(f);
      await this.mic.start();
      this.session.setListening(true);
    } catch (err) {
      this.transcript.error(`Microphone unavailable: ${(err as Error).message}. Check that Obsidian may use the microphone in your system settings.`);
    }
  }

  // --- the system-wide shortcut ---

  /** (Re)registers the shortcut from the settings. Returns why it failed, or ''. */
  applyGlobalShortcut(): string {
    this.shortcutError = this.shortcut.set(this.settings.globalShortcut);
    return this.shortcutError;
  }

  /** Lets go of the shortcut while the settings record a new one. */
  pauseGlobalShortcut(): void {
    this.shortcut.clear();
  }

  /**
   * One spoken question from any app: a tone, listen, and close the mic once
   * the user stops talking (or says nothing for a while). Pressing it while
   * listening cancels; pressing it while Cortana talks silences her first (the
   * question that follows interrupts her turn, as any new utterance does).
   */
  async talkFromAnywhere(): Promise<void> {
    if (!this.session) return void new Notice('Cortana is still starting.');
    if (this.mic.active) return this.toggleListening();
    this.session.stopSpeaking();
    this.oneShot = true;
    await this.toggleListening({ background: true });
    if (!this.mic.active) return this.clearOneShot();
    playCue('start');
    this.armOneShotTimer();
  }

  private onOneShotVad(type: 'start' | 'end' | 'discard'): void {
    if (!this.oneShot) return;
    if (type === 'start') window.clearTimeout(this.oneShotTimer);
    else if (type === 'discard') this.armOneShotTimer();
    else this.endOneShot();
  }

  private armOneShotTimer(): void {
    window.clearTimeout(this.oneShotTimer);
    this.oneShotTimer = window.setTimeout(() => this.endOneShot(), ONE_SHOT_SILENCE_MS);
  }

  private endOneShot(): void {
    if (!this.oneShot) return;
    this.clearOneShot();
    if (!this.mic.active) return;
    this.mic.stop();
    this.session?.setListening(false);
    playCue('stop');
  }

  private clearOneShot(): void {
    this.oneShot = false;
    window.clearTimeout(this.oneShotTimer);
  }

  async sendText(text: string): Promise<void> {
    if (!this.session) return void new Notice('Cortana is still starting.');
    if (this.tts && !this.warmed) this.warmup();
    await this.session.sendText(text);
  }

  interrupt(): void {
    this.session?.interrupt();
  }

  /** Speaks a sample sentence with the current voice (settings, Test voice). */
  async previewVoice(): Promise<void> {
    const tts = this.tts ?? this.buildTts();
    if (!tts) return;
    try {
      this.player.stop();
      await this.player.enqueue(tts.synthesize(`Hi, I'm ${assistantName(this.settings.assistantName)}. This is how I sound.`));
    } catch (err) {
      new Notice(`Voice test failed: ${(err as Error).message}`);
    }
  }

  async newConversation(): Promise<void> {
    this.interrupt();
    await this.agent?.resetConversation();
    this.transcript.clear();
  }

  // --- panel ---

  private panelVisible(): boolean {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).some(l => l.view instanceof CortanaView && l.view.containerEl.isShown());
  }

  private setNotice(text: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      // A panel in a background tab is a DeferredView until shown.
      if (leaf.view instanceof CortanaView) leaf.view.setNotice(text);
    }
  }

  async openPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  // --- settings ---

  /** A setup warning, shown once per path rather than on every launch. */
  private warnOnce(key: string, text: string): void {
    if (this.warned.includes(key)) return;
    this.warned.push(key);
    new Notice(text, 15000);
    void this.saveData({ settings: this.settings, warned: this.warned });
  }

  /** Makes an empty board at the board path, unless one is there. */
  async makeBoard(): Promise<void> {
    const { boardPath } = getLayout();
    try {
      if (await createBoard(this.vaultOps(), this.vaultPath)) {
        new Notice(`Board created at "${boardPath}".`);
        const file = this.app.vault.getFileByPath(boardPath);
        if (file) await this.app.workspace.getLeaf(true).openFile(file);
      } else new Notice(`There is already a board at "${boardPath}".`);
    } catch (err) {
      new Notice(`Could not create the board: ${(err as Error).message}`);
    }
  }

  /** True when the board note exists. */
  hasBoard(): boolean {
    return existsSync(boardFile(this.vaultPath));
  }

  // --- other AIs (MCP) ---

  /** Starts, restarts or stops the local MCP server to match the settings. */
  async applyMcp(): Promise<void> {
    const running = this.mcp;
    this.mcp = undefined;
    this.mcpError = '';
    await running?.close();
    const store = this.store;
    if (!this.settings.connectAis || !store || this.unloaded) return;
    const handler = new McpHandler({
      context: () => ({ vaultPath: this.vaultPath, ops: this.vaultOps(), store, onWrite: (client, summary, changes) => this.outsideWrite(client, summary, changes) }),
      allowWrites: () => this.settings.mcpWrites,
      version: this.manifest.version,
    });
    try {
      this.mcp = await startMcpServer(handler, this.settings.mcpPort, this.mcpToken());
      if (this.unloaded) void this.mcp.close();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      this.mcpError = code === 'EADDRINUSE' ? `port ${this.settings.mcpPort} is in use. Pick another port.` : (err as Error).message;
      createLogger('mcp').error('Could not start', err);
    }
  }

  /** The address other AIs connect to. */
  mcpUrl(): string {
    return `http://127.0.0.1:${this.settings.mcpPort}/mcp`;
  }

  mcpToken(): string {
    let token = this.app.secretStorage.getSecret(MCP_TOKEN_SECRET);
    if (!token) {
      token = newToken();
      this.app.secretStorage.setSecret(MCP_TOKEN_SECRET, token);
    }
    return token;
  }

  /** A new token: every connected AI must be set up again. */
  async resetMcpToken(): Promise<void> {
    this.app.secretStorage.setSecret(MCP_TOKEN_SECRET, newToken());
    await this.applyMcp();
  }

  /** Shows what another AI changed in the panel and keeps a line in the agent log. */
  private outsideWrite(client: string, summary: string, changes: NoteChange[]): void {
    void this.session?.proactive(`${client}: ${summary}`, 'outside-ai', { changes, speak: false });
    void appendAgentLog(this.vaultOps(), localDate(new Date()), 'outside-ai', `${client}: ${summary}`);
  }

  async saveSettings(opts: { restartAgent?: boolean; voice?: boolean; engine?: boolean; mcp?: boolean; name?: boolean } = {}): Promise<void> {
    await this.saveData({ settings: this.settings, warned: this.warned });
    if (opts.name) {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        if (leaf.view instanceof CortanaView) leaf.view.rename();
      }
    }
    if (opts.mcp) await this.applyMcp();
    if (opts.restartAgent) {
      setLayout(this.settings.layout);
      this.agent?.updateSettings(this.agentSettings());
    }
    if (opts.engine) this.agent?.setEngineFactory(this.engineFactory());
    if (opts.voice) this.rebuildVoice();
  }
}
