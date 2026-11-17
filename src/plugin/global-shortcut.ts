// plugin/global-shortcut.ts - a shortcut that works while another app is in front.
//
// Obsidian has no system-wide hotkeys. Electron does (globalShortcut), and
// Obsidian exposes it to plugins through @electron/remote. That is not an
// official Obsidian API, so everything here fails soft: no remote, no shortcut.

export interface ShortcutApi {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

function electronShortcuts(): ShortcutApi | null {
  try {
    const req = (window as unknown as { require?: (m: string) => unknown }).require;
    const electron = req?.('electron') as { remote?: { globalShortcut?: ShortcutApi } } | undefined;
    return electron?.remote?.globalShortcut ?? null;
  } catch {
    return null;
  }
}

export class GlobalShortcut {
  private current = '';

  constructor(private readonly onPress: () => void, private readonly api: ShortcutApi | null = electronShortcuts()) {}

  get active(): string {
    return this.current;
  }

  /** Replaces the shortcut. Returns why it could not be set, or '' (also for an empty one). */
  set(accelerator: string): string {
    this.clear();
    const accel = accelerator.trim();
    if (!accel) return '';
    if (!this.api) return 'This version of Obsidian does not let plugins use system-wide shortcuts.';
    // A plugin reload does not restart Obsidian, and a key Obsidian already holds
    // cannot be registered again. Unregister only drops Obsidian's own claim on
    // the key (an earlier load of this plugin), never another app's.
    try {
      this.api.unregister(accel);
    } catch {
      // Not registered.
    }
    let ok: boolean;
    try {
      ok = this.api.register(accel, () => this.onPress());
    } catch {
      return `${accel} is not a valid shortcut.`;
    }
    if (!ok) return `${accel} is taken by another app. Pick a different one.`;
    this.current = accel;
    return '';
  }

  clear(): void {
    if (this.current && this.api) {
      try {
        this.api.unregister(this.current);
      } catch {
        // Already gone with the window.
      }
    }
    this.current = '';
  }
}

/** What the recorder needs from a keydown. */
export interface KeyPress {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const NAMED_KEYS: Record<string, string> = {
  Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};

/** The key part of an accelerator, from KeyboardEvent.code (layout and Option-proof). */
function keyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return NAMED_KEYS[code] ?? null;
}

export type RecordResult = { accelerator: string } | { pending: true } | { error: string };

/**
 * Turns a keydown into an Electron accelerator. A lone modifier means "keep
 * going"; a plain key (or Shift + key) is refused, since it would stop that key
 * from typing in every app. F-keys may stand alone.
 */
export function acceleratorFromKey(e: KeyPress, isMac: boolean): RecordResult {
  if (/^(Meta|OS|Control|Alt|Shift)(Left|Right)?$/.test(e.code)) return { pending: true };
  const key = keyName(e.code);
  if (!key) return { error: 'That key cannot be used. Try a letter, a number, Space or an F-key.' };
  const mods = [
    e.metaKey ? (isMac ? 'Command' : 'Super') : '',
    e.ctrlKey ? 'Control' : '',
    e.altKey ? 'Alt' : '',
    e.shiftKey ? 'Shift' : '',
  ].filter(Boolean);
  const strong = e.metaKey || e.ctrlKey || e.altKey;
  if (!strong && !/^F\d+$/.test(key)) {
    return { error: `Hold ${isMac ? 'Option, Control or Command' : 'Alt, Control or the Windows key'} too, or it would stop that key typing everywhere.` };
  }
  return { accelerator: [...mods, key].join('+') };
}

/** An accelerator as people say it on this system: Option+Shift+Space on a Mac. */
export function formatAccelerator(accel: string, isMac: boolean): string {
  const names: Record<string, string> = isMac
    ? { Alt: 'Option', Option: 'Option', Command: 'Command', Cmd: 'Command', CommandOrControl: 'Command', CmdOrCtrl: 'Command', Control: 'Control', Ctrl: 'Control', Super: 'Command', Meta: 'Command' }
    : { Alt: 'Alt', Option: 'Alt', Command: 'Control', Cmd: 'Control', CommandOrControl: 'Control', CmdOrCtrl: 'Control', Control: 'Control', Ctrl: 'Control', Super: 'Windows', Meta: 'Windows' };
  return accel.split('+').map(p => names[p] ?? p).join('+');
}
