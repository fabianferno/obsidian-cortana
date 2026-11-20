// plugin/settings.ts - everything the user can set, and the settings tab.

import { App, ButtonComponent, Notice, Platform, PluginSettingTab, SecretComponent, Setting, requireApiVersion, type SettingDefinitionItem } from 'obsidian';
import { acceleratorFromKey, formatAccelerator } from './global-shortcut.js';
import { sarvamVoices, type VoiceOption } from '../voice/voices.js';
import type CortanaPlugin from './main.js';
import { ENGINES, ENGINE_INFO, type EngineName } from '../engines/index.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../config/paths.js';
import { parseTime } from '../checkins/scheduler.js';
import { pickBestVoice, systemVoices, voiceQuality, type VoiceInfo } from '../voice/system.js';
import { SETUP_CLIENTS, setupSnippet, type SetupClient } from '../mcp/setup.js';
import { NAME } from '../brand.js';

export * from './settings-data.js';
import { type SttChoice, type StringSettingKey, type TtsChoice, type CortanaSettings } from './settings-data.js';

const VOICE_TIP = Platform.isMacOS
  ? 'Automatic uses your best installed voice for your language. For a much more natural one, download a Premium or Enhanced voice in System Settings, Accessibility, Spoken Content, System voice, Manage voices, then restart Obsidian. (Personal Voice is not available to Obsidian.)'
  : Platform.isWin
    ? 'More voices: Windows Settings, Time & language, Speech, Add voices. Then restart Obsidian.'
    : 'Voices come from speech-dispatcher (for example espeak-ng or piper).';

/** Voices in the system language first, best quality first, then alphabetical. */
function sortVoices(voices: VoiceInfo[]): VoiceInfo[] {
  const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
  const rank = (v: VoiceInfo) => (v.lang.toLowerCase().startsWith(lang) ? 0 : 1);
  return [...voices].sort((a, b) => rank(a) - rank(b) || voiceQuality(b.name) - voiceQuality(a.name) || a.name.localeCompare(b.name));
}

/** One settings row: what search sees (name, desc, visible) and how to draw it. */
interface Row {
  name: string;
  desc?: string;
  visible?: () => boolean;
  /** May return a cleanup function, run before the row is torn down. */
  build?: (setting: Setting) => unknown;
}

interface Section {
  heading: string;
  rows: Row[];
}

const WHISPER_MODELS: Record<string, string> = {
  'Xenova/whisper-tiny.en': 'Tiny (English, fastest)',
  'Xenova/whisper-base.en': 'Base (English, recommended)',
  'Xenova/whisper-small.en': 'Small (English, most accurate, slower)',
  'Xenova/whisper-base': 'Base (multilingual)',
};

export class CortanaSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: CortanaPlugin) {
    super(app, plugin);
  }

  /** Obsidian 1.13+: drawn by Obsidian and indexed for settings search. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return this.sections().map(section => ({
      type: 'group' as const,
      heading: section.heading,
      items: section.rows.map(row => ({
        name: row.name,
        ...(row.desc ? { desc: row.desc } : {}),
        ...(row.visible ? { visible: row.visible } : {}),
        render: (setting: Setting) => this.draw(setting, row),
      })),
    }));
  }

  /** Fallback for Obsidian before 1.13 (minAppVersion is 1.11.4). Bypassed on 1.13+. */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    for (const section of this.sections()) {
      new Setting(containerEl).setName(section.heading).setHeading();
      for (const row of section.rows) {
        if (row.visible && !row.visible()) continue;
        this.draw(new Setting(containerEl), row);
      }
    }
  }

  /** Redraw after a change that adds, hides or rewords rows. */
  private refresh(): void {
    if (requireApiVersion('1.13.0')) this.update();
    else this.display();
  }

  private draw(setting: Setting, row: Row): void | (() => void) {
    setting.setName(row.name);
    if (row.desc) setting.setDesc(row.desc);
    const cleanup = row.build?.(setting);
    return typeof cleanup === 'function' ? cleanup as () => void : undefined;
  }

  private sections(): Section[] {
    const s = this.plugin.settings;
    const save = async (opts: { restartAgent?: boolean; voice?: boolean; engine?: boolean; mcp?: boolean } = {}) => {
      await this.plugin.saveSettings(opts);
    };
    const usesSarvam = () => s.stt === 'sarvam' || s.tts === 'sarvam';
    const usesSoniox = () => s.stt === 'soniox' || s.tts === 'soniox';
    const sarvamSpeakers = sarvamVoices(s.sarvamTtsModel);

    const naming: Row[] = [
      this.text('Its name', `What the assistant is called. Leave empty for "${NAME}".`, 'assistantName', undefined,
        { placeholder: NAME, save: { restartAgent: true, name: true } }),
      this.text('What it calls you', 'Your name or a nickname. Leave empty to use the name in user.md.', 'userTitle', undefined,
        { save: { restartAgent: true } }),
    ];

    const brain: Row[] = [
      {
        name: 'Engine',
        desc: 'The coding agent that thinks and works in your vault. It must be installed and signed in on this computer.',
        build: setting => setting
          .addDropdown(d => {
            for (const e of ENGINES) d.addOption(e, ENGINE_INFO[e].label);
            d.setValue(s.engine).onChange(async v => {
              s.engine = v as EngineName;
              await save({ engine: true });
              this.refresh();
            });
          })
          .addButton(b => b.setButtonText('Check').onClick(async () => {
            try {
              new Notice(`${ENGINE_INFO[s.engine].label}: ${await this.plugin.checkEngine()}`);
            } catch (err) {
              new Notice((err as Error).message, 10000);
            }
          })),
      },
      {
        name: 'Path to binary',
        desc: `Leave empty to find "${ENGINE_INFO[s.engine].bin}" on your PATH.`,
        build: setting => setting.addText(t => t.setPlaceholder(ENGINE_INFO[s.engine].bin).setValue(s.engineBin[s.engine]).onChange(async v => {
          s.engineBin[s.engine] = v.trim();
          await save({ engine: true });
        })),
      },
      {
        name: 'Model',
        desc: 'Optional. Passed to the engine as --model (for example "sonnet" or "opus" for Claude Code).',
        build: setting => setting.addText(t => t.setValue(s.model).onChange(async v => {
          s.model = v.trim();
          await save({ engine: true });
        })),
      },
      {
        name: 'Permissions',
        desc: 'Edit: the engine may read and edit notes. Full: no restrictions, including shell commands. Use full only if you trust it with your machine.',
        build: setting => setting.addDropdown(d => d.addOption('edit', 'Edit notes').addOption('full', 'Full access').setValue(s.permissions).onChange(async v => {
          s.permissions = v as 'edit' | 'full';
          await save({ engine: true });
        })),
      },
      {
        name: 'Extra arguments',
        desc: 'Optional flags passed to the engine CLI as-is.',
        build: setting => setting.addText(t => t.setValue(s.extraArgs).onChange(async v => {
          s.extraArgs = v;
          await save({ engine: true });
        })),
      },
      this.toggle('See what you have open', 'Cortana knows which note is open and what you selected, so "summarize this" works. It brings it up only when it helps. During a focus session it also notices which notes you type in. Daily notes and the board are never included.', 'seeWorkspace'),
    ];

    const voice: Row[] = [
      {
        name: 'Listen with',
        desc: 'Local runs Whisper on this computer: free, private, no key. Downloads the model once.',
        build: setting => setting.addDropdown(d => d.addOption('local', 'Local (Whisper)').addOption('sarvam', 'Sarvam').addOption('soniox', 'Soniox')
          .setValue(s.stt).onChange(async v => {
            s.stt = v as SttChoice;
            await save({ voice: true });
            this.refresh();
          })),
      },
      {
        name: 'Speak with',
        desc: 'System voice is built into your computer: instant, private, no download, no key. ElevenLabs, Sarvam and Soniox are cloud voices that need a key.',
        build: setting => setting.addDropdown(d => d.addOption('system', 'System voice').addOption('elevenlabs', 'ElevenLabs').addOption('sarvam', 'Sarvam').addOption('soniox', 'Soniox').addOption('off', 'Off (text only)')
          .setValue(s.tts).onChange(async v => {
            s.tts = v as TtsChoice;
            await save({ voice: true });
            this.refresh();
          })),
      },
      {
        name: 'Whisper model',
        visible: () => s.stt === 'local',
        build: setting => setting.addDropdown(d => {
          for (const [id, label] of Object.entries(WHISPER_MODELS)) d.addOption(id, label);
          d.setValue(s.localSttModel).onChange(async v => {
            s.localSttModel = v;
            await save({ voice: true });
          });
        }),
      },
      {
        name: 'System voice',
        desc: VOICE_TIP,
        visible: () => s.tts === 'system',
        build: setting => setting.addDropdown(d => {
          d.addOption('', 'Automatic (best voice installed)');
          if (s.systemVoice) d.addOption(s.systemVoice, s.systemVoice);
          d.setValue(s.systemVoice).onChange(async v => {
            s.systemVoice = v;
            await save({ voice: true });
          });
          void (async () => {
            const voices = await systemVoices();
            for (const v of sortVoices(voices)) if (v.name !== s.systemVoice) d.addOption(v.name, `${v.name} (${v.lang})`);
            d.setValue(s.systemVoice);
            const auto = pickBestVoice(voices, navigator.language || 'en-US');
            if (auto) d.selectEl.options[0].text = `Automatic (now: ${auto.name})`;
          })().catch(() => undefined);
        }),
      },
      {
        name: 'Speaking speed',
        visible: () => s.tts === 'system',
        build: setting => setting.addSlider(sl => sl.setLimits(0.7, 1.5, 0.05).setValue(s.speechRate).onChange(async v => {
          s.speechRate = v;
          await save({ voice: true });
        })),
      },
      this.secret('ElevenLabs API key', 'Click Link, enter a short name such as "elevenlabs" as the ID, and paste your ElevenLabs API key (elevenlabs.io, Developers, API keys) as the secret. The key stays in Obsidian\'s secret storage, not in the plugin settings file.', 'elevenlabsSecret', () => s.tts === 'elevenlabs'),
      this.voicePicker('ElevenLabs voice', 'The voices in your ElevenLabs library, loaded with your key.', 'elevenlabsVoice', () => this.plugin.listVoices('elevenlabs'), () => s.tts === 'elevenlabs'),
      this.text('ElevenLabs model', 'eleven_flash_v2_5 is the fastest. eleven_multilingual_v2 sounds richer but is slower. eleven_v3 is the most expressive, and Cortana adds voice cues such as [warm] for it.', 'elevenlabsModel', () => s.tts === 'elevenlabs'),
      {
        name: 'Test voice',
        desc: 'Say a short sentence with the current voice.',
        visible: () => s.tts !== 'off',
        build: setting => setting.addButton(b => b.setButtonText('Play').onClick(() => void this.plugin.previewVoice())),
      },
      this.secret('Sarvam API key', 'Click Link, enter a short name such as "sarvam" as the ID, and paste your Sarvam API key (dashboard.sarvam.ai, API keys) as the secret. The key stays in Obsidian\'s secret storage, not in the plugin settings file.', 'sarvamSecret', usesSarvam),
      this.text('Sarvam recognition language', 'Language code, or "unknown" to detect.', 'sarvamSttLanguage', () => s.stt === 'sarvam'),
      {
        name: 'Sarvam voice model',
        desc: 'bulbul:v3 has 37 speakers. bulbul:v4-flash has 200+ persona voices.',
        visible: () => s.tts === 'sarvam',
        build: setting => setting.addDropdown(d => {
          for (const m of ['bulbul:v3', 'bulbul:v4-flash', 'bulbul:v2']) d.addOption(m, m);
          if (!d.selectEl.querySelector(`option[value="${CSS.escape(s.sarvamTtsModel)}"]`)) d.addOption(s.sarvamTtsModel, s.sarvamTtsModel);
          d.setValue(s.sarvamTtsModel).onChange(async v => {
            s.sarvamTtsModel = v;
            s.sarvamTtsSpeaker = '';
            await save({ voice: true });
            this.refresh();
          });
        }),
      },
      sarvamSpeakers.length
        ? this.voicePicker('Sarvam speaker', 'Sarvam\'s speakers for this model.', 'sarvamTtsSpeaker', () => Promise.resolve(sarvamSpeakers), () => s.tts === 'sarvam', 'Default for the model')
        : this.text('Sarvam speaker', 'A speaker ID from the voices page at docs.sarvam.ai, such as shubh_enhi_ads. Leave empty for the default.', 'sarvamTtsSpeaker', () => s.tts === 'sarvam'),
      this.text('Sarvam speech language', 'For example en-IN or hi-IN. With an Indian language, Cortana writes it in its own script, as Sarvam recommends.', 'sarvamTtsLanguage', () => s.tts === 'sarvam'),
      this.secret('Soniox API key', 'Click Link, enter a short name such as "soniox" as the ID, and paste your Soniox API key (console.soniox.com, API keys) as the secret. The key stays in Obsidian\'s secret storage, not in the plugin settings file.', 'sonioxSecret', usesSoniox),
      this.text('Soniox recognition model', '', 'sonioxSttModel', () => s.stt === 'soniox'),
      this.text('Soniox voice model', 'For example tts-rt-v2. Reopen settings after changing it to reload the voices.', 'sonioxTtsModel', () => s.tts === 'soniox'),
      this.voicePicker('Soniox voice', 'Soniox\'s voices for this model, loaded with your key.', 'sonioxTtsVoice', () => this.plugin.listVoices('soniox'), () => s.tts === 'soniox'),
      this.text('Soniox language', '', 'sonioxLanguage', usesSoniox),
      this.toggle('Speak briefings and nudges', 'Read proactive messages aloud, not just show them.', 'speakProactive', { voice: true }),
      this.toggle('Interrupt by talking', 'Your voice cuts the agent off mid-sentence. Best with headphones, or it may hear itself.', 'bargeIn', { voice: true }),
      this.toggle('Listen when the panel opens', 'Turn the microphone on automatically.', 'listenOnOpen'),
      this.shortcutRow(),
    ];

    const checkins: Row[] = [
      ...([['morning', 'Morning briefing'], ['midday', 'Midday check'], ['evening', 'Evening wind-down']] as const).map(([key, label]): Row => ({
        name: label,
        desc: 'Local time, HH:MM. Empty turns it off.',
        build: setting => setting.addText(t => t.setPlaceholder('off').setValue(s.checkpointTimes[key]).onChange(async v => {
          const value = v.trim();
          if (value && !parseTime(value)) return;
          s.checkpointTimes[key] = value;
          await save({ restartAgent: true });
        })),
      })),
      this.toggle('Greet when Obsidian opens', 'A short snapshot when you open Obsidian (at most every 3 hours).', 'greetOnOpen', { restartAgent: true }),
      this.toggle('Nudges between check-ins', 'Short adaptive nudges. Quiet hours and the pulse interval come from user.md.', 'pulses', { restartAgent: true }),
    ];

    const secondBrain: Row[] = [
      this.toggle('File things from conversations', 'People, projects, your own ideas and decisions you mention get a dated line in their note, or a new note in the capture folder.', 'capture', { restartAgent: true }),
      this.toggle('Tend capture notes daily', 'Off by default. Once a day the agent tidies ready notes in the capture folder and moves them to the notes folder, or leaves a question inside the note. Your words are never rewritten.', 'graduate', { restartAgent: true }),
      {
        name: 'Notes per day',
        desc: 'How many capture notes the daily pass works on. Each one is a turn of your engine. The /graduate command runs a pass now.',
        build: setting => setting.addText(t => t.setPlaceholder('5').setValue(String(s.graduatePerDay)).onChange(async v => {
          const n = Number.parseInt(v, 10);
          if (!Number.isFinite(n) || n < 1 || n > 50) return;
          s.graduatePerDay = n;
          await save({ restartAgent: true });
        })),
      },
    ];

    const layoutText = (name: string, desc: string, key: keyof VaultLayout): Row => ({
      name,
      desc,
      build: setting => setting.addText(t => t.setPlaceholder(DEFAULT_LAYOUT[key]).setValue(s.layout[key]).onChange(async v => {
        s.layout[key] = v.trim().replace(/^\/+|\/+$/g, '');
        await save({ restartAgent: true, engine: true });
      })),
    });
    const layout: Row[] = [
      layoutText('Kanban board', 'Path to your board note: "## Column" headings with "- [ ] card" lines. The Kanban plugin shows it as a board, but it is optional.', 'boardPath'),
      {
        name: 'No board yet',
        desc: 'Make an empty board with Backlog, To Do, Doing and Done at the path above. You can also ask Cortana to make one.',
        visible: () => !this.plugin.hasBoard(),
        build: setting => setting.addButton(b => b.setButtonText('Create board').onClick(async () => {
          await this.plugin.makeBoard();
          this.refresh();
        })),
      },
      layoutText('Agent folder', 'Where soul.md, identity.md, user.md, goals.md and memory.md live. Created on first run.', 'agentFolder'),
      layoutText('Capture folder', 'Quick capture. New notes start here; the daily pass moves them to the notes folder when they are ready. Empty turns the pass off.', 'captureFolder'),
      layoutText('Notes folder', 'Where finished notes go.', 'notesFolder'),
      layoutText('Daily notes folder', 'The agent never reads or writes here.', 'dailyFolder'),
    ];

    const on = () => s.connectAis;
    let client: SetupClient = 'claude-code';
    const copy = (text: string, what: string) => {
      navigator.clipboard.writeText(text).then(() => new Notice(`${what} copied.`), () => new Notice('Could not copy.'));
    };
    const otherAis: Row[] = [
      {
        name: 'Let other AIs use your vault',
        desc: 'Claude Code, Codex, Cursor, Gemini CLI and other AI apps on this computer can connect to Cortana (MCP). They see what Cortana knows about you and your board, search your notes and file what you tell them, with the same rules as Cortana: never your daily notes or Cortana\'s own files, and your own lines are never changed. Only this computer can connect, with the token below.',
        build: setting => setting.addToggle(t => t.setValue(s.connectAis).onChange(async v => {
          s.connectAis = v;
          await save({ mcp: true });
          this.refresh();
        })),
      },
      {
        name: 'Status',
        visible: on,
        build: setting => setting.setDesc(this.plugin.mcpError ? `Not running: ${this.plugin.mcpError}` : `Running at ${this.plugin.mcpUrl()}`),
      },
      {
        name: 'Let them make changes',
        desc: 'File notes, remember facts about you and add or move cards. Each change shows in the Cortana panel and in log.md in the agent folder. Off: they can only read.',
        visible: on,
        build: setting => setting.addToggle(t => t.setValue(s.mcpWrites).onChange(async v => {
          s.mcpWrites = v;
          await save();
        })),
      },
      {
        name: 'Connect an app',
        desc: 'Copy the setup for your app and paste it where the label says, then restart the app. It includes your token. Web apps (claude.ai, ChatGPT, grok.com) cannot reach this computer.',
        visible: on,
        build: setting => setting
          .addDropdown(d => {
            for (const [id, label] of Object.entries(SETUP_CLIENTS)) d.addOption(id, label);
            d.setValue(client).onChange(v => { client = v as SetupClient; });
          })
          .addButton(b => b.setButtonText('Copy setup').setCta().onClick(() => copy(setupSnippet(client, this.plugin.mcpUrl(), this.plugin.mcpToken()), 'Setup'))),
      },
      {
        name: 'Access token',
        desc: 'Kept in Obsidian\'s secret storage. A new token disconnects every app until you paste the new setup.',
        visible: on,
        build: setting => setting
          .addButton(b => b.setButtonText('Copy token').onClick(() => copy(this.plugin.mcpToken(), 'Token')))
          .addButton(b => b.setButtonText('New token').onClick(async () => {
            await this.plugin.resetMcpToken();
            new Notice('New token made. Set up your apps again.');
          })),
      },
      {
        name: 'Port',
        desc: 'Change it only if another program uses it.',
        visible: on,
        build: setting => setting.addText(t => t.setPlaceholder('27150').setValue(String(s.mcpPort)).onChange(async v => {
          const n = Number.parseInt(v, 10);
          if (!Number.isInteger(n) || n < 1024 || n > 65535) return;
          s.mcpPort = n;
          await save({ mcp: true });
        })),
      },
    ];

    return [
      { heading: 'Name', rows: naming },
      { heading: 'Brain', rows: brain },
      { heading: 'Voice', rows: voice },
      { heading: 'Check-ins', rows: checkins },
      { heading: 'Second brain', rows: secondBrain },
      { heading: 'Other AIs', rows: otherAis },
      { heading: 'Vault layout', rows: layout },
    ];
  }

  /** An API key kept in Obsidian's secret storage. */
  private secret(name: string, desc: string, key: 'elevenlabsSecret' | 'sarvamSecret' | 'sonioxSecret', visible: () => boolean): Row {
    const s = this.plugin.settings;
    return {
      name,
      desc,
      visible,
      build: setting => setting.addComponent(el => new SecretComponent(this.app, el).setValue(s[key]).onChange(async v => {
        s[key] = v ?? '';
        await this.plugin.saveSettings({ voice: true });
        this.refresh();
      })),
    };
  }

  /**
   * A dropdown of voices that loads in the background. The saved voice stays
   * selectable even if the list does not include it. If loading fails (no key,
   * rejected key, offline), the reason shows and a text field takes over so a
   * voice ID can still be typed.
   */
  private voicePicker(name: string, desc: string, key: StringSettingKey, load: () => Promise<VoiceOption[]>, visible: () => boolean, emptyLabel?: string): Row {
    const settings = this.plugin.settings as unknown as Record<string, string>;
    return {
      name,
      desc,
      visible,
      build: setting => {
        const current = settings[key];
        setting.setDesc('Loading voices...');
        setting.addDropdown(d => {
          if (emptyLabel) d.addOption('', emptyLabel);
          if (current) d.addOption(current, current);
          d.setValue(current).onChange(async v => {
            settings[key] = v;
            await this.plugin.saveSettings({ voice: true });
          });
          // Do not call a voice API for a row the user cannot see.
          if (!visible()) return;
          load().then(voices => {
            d.selectEl.empty();
            if (emptyLabel) d.addOption('', emptyLabel);
            if (current && !voices.some(v => v.id === current)) d.addOption(current, `${current} (not in the list)`);
            for (const v of voices) d.addOption(v.id, v.label);
            d.setValue(current);
            setting.setDesc(voices.length ? `${desc} ${voices.length} available.` : `${desc} None found.`);
          }, (err: unknown) => {
            setting.setDesc(`Could not load voices: ${(err as Error).message}. Type a voice ID instead.`);
            setting.controlEl.empty();
            setting.addText(t => t.setPlaceholder('Voice ID').setValue(current).onChange(async v => {
              settings[key] = v.trim();
              await this.plugin.saveSettings({ voice: true });
            }));
          });
        });
      },
    };
  }

  /** The system-wide shortcut: click, press the keys, done. */
  private shortcutRow(): Row {
    const mac = Platform.isMacOS;
    const about = 'Ask Cortana one question from any app while Obsidian is running: press it, hear a tone, talk. The mic closes when you stop. Press again to cancel. The shortcut stops working in every other app, so pick one you do not use.';
    const settings = this.plugin.settings;
    return {
      name: 'Talk from anywhere',
      desc: about,
      build: setting => {
        let button: ButtonComponent | undefined;
        const show = (note = this.plugin.shortcutError ? `Not set: ${this.plugin.shortcutError}` : '') => {
          setting.setDesc(note ? `${about} ${note}` : about);
          button?.setButtonText(settings.globalShortcut ? formatAccelerator(settings.globalShortcut, mac) : 'Set shortcut');
        };
        const save = async (accel: string) => {
          settings.globalShortcut = accel;
          await this.plugin.saveSettings();
          this.plugin.applyGlobalShortcut();
          show();
        };

        setting.addButton(b => {
          button = b;
          b.setTooltip('Click, then press the keys you want').onClick(() => {
            if (this.stopRecording) return this.stopRecording();
            // Free the current key so pressing it again can be recorded.
            this.plugin.pauseGlobalShortcut();
            b.setButtonText('Press the keys...');
            setting.setDesc(`${about} Press the keys now, or Esc to cancel.`);
            const onKey = (e: KeyboardEvent) => {
              e.preventDefault();
              e.stopPropagation();
              if (e.code === 'Escape') return this.stopRecording?.();
              const r = acceleratorFromKey(e, mac);
              if ('pending' in r) return;
              if ('error' in r) return void setting.setDesc(`${about} ${r.error}`);
              finish();
              void save(r.accelerator);
            };
            const finish = () => {
              activeDocument.removeEventListener('keydown', onKey, true);
              this.stopRecording = undefined;
            };
            this.stopRecording = () => {
              finish();
              this.plugin.applyGlobalShortcut();
              show();
            };
            activeDocument.addEventListener('keydown', onKey, true);
          });
        });
        setting.addExtraButton(b => b.setIcon('x').setTooltip('Turn the shortcut off').onClick(() => {
          this.stopRecording?.();
          void save('');
        }));
        show();
        return () => this.stopRecording?.();
      },
    };
  }

  /** Ends a shortcut recording in progress (the button again, Esc, or leaving the tab). */
  private stopRecording?: () => void;

  hide(): void {
    this.stopRecording?.();
    super.hide();
  }

  private text(
    name: string, desc: string, key: StringSettingKey, visible?: () => boolean,
    opts: { placeholder?: string; save?: Parameters<CortanaPlugin['saveSettings']>[0] } = {},
  ): Row {
    return {
      name,
      desc,
      ...(visible ? { visible } : {}),
      build: setting => setting.addText(t => t.setPlaceholder(opts.placeholder ?? '').setValue(this.plugin.settings[key]).onChange(async v => {
        (this.plugin.settings as unknown as Record<string, unknown>)[key] = v.trim();
        await this.plugin.saveSettings(opts.save ?? { voice: true });
      })),
    };
  }

  private toggle(name: string, desc: string, key: keyof CortanaSettings, opts: { restartAgent?: boolean; voice?: boolean } = {}): Row {
    return {
      name,
      desc,
      build: setting => setting.addToggle(t => t.setValue(Boolean(this.plugin.settings[key])).onChange(async v => {
        (this.plugin.settings as unknown as Record<string, unknown>)[key] = v;
        await this.plugin.saveSettings(opts);
      })),
    };
  }
}
