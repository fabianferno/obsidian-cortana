import { describe, it, expect, vi } from 'vitest';
import { GlobalShortcut, acceleratorFromKey, formatAccelerator, type KeyPress, type ShortcutApi } from '../src/plugin/global-shortcut.js';

function fakeApi(taken: string[] = []) {
  const registered = new Map<string, () => void>();
  const api: ShortcutApi = {
    register: (accel, cb) => {
      if (accel.includes('??')) throw new Error('conversion failure');
      if (taken.includes(accel)) return false;
      registered.set(accel, cb);
      return true;
    },
    unregister: (accel) => { registered.delete(accel); },
  };
  return { api, registered };
}

describe('GlobalShortcut', () => {
  it('registers, fires, and swaps the old shortcut out', () => {
    const { api, registered } = fakeApi();
    const press = vi.fn();
    const s = new GlobalShortcut(press, api);
    expect(s.set('Alt+Shift+Space')).toBe('');
    registered.get('Alt+Shift+Space')?.();
    expect(press).toHaveBeenCalledOnce();
    s.set('Alt+Shift+K');
    expect([...registered.keys()]).toEqual(['Alt+Shift+K']);
    s.clear();
    expect(registered.size).toBe(0);
  });

  it('explains a taken, invalid or unavailable shortcut, and treats empty as off', () => {
    const { api, registered } = fakeApi(['Alt+Space']);
    const s = new GlobalShortcut(() => undefined, api);
    expect(s.set('Alt+Space')).toMatch(/taken by another app/);
    expect(s.set('Alt+??')).toMatch(/not a valid shortcut/);
    expect(s.set('  ')).toBe('');
    expect(registered.size).toBe(0);
    expect(new GlobalShortcut(() => undefined, null).set('Alt+Shift+Space')).toMatch(/does not let plugins/);
  });
  it('takes the key back from an earlier load of the plugin', () => {
    const { api, registered } = fakeApi();
    // Left behind by a load whose cleanup never ran: register() refuses a held key.
    registered.set('Alt+Shift+Space', () => undefined);
    const press = vi.fn();
    expect(new GlobalShortcut(press, api).set('Alt+Shift+Space')).toBe('');
    registered.get('Alt+Shift+Space')?.();
    expect(press).toHaveBeenCalledOnce();
  });
});

const key = (code: string, mods: Partial<KeyPress> = {}): KeyPress =>
  ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe('acceleratorFromKey', () => {
  it('builds an accelerator from modifiers and the physical key', () => {
    expect(acceleratorFromKey(key('Space', { altKey: true, shiftKey: true }), true)).toEqual({ accelerator: 'Alt+Shift+Space' });
    expect(acceleratorFromKey(key('KeyK', { metaKey: true, ctrlKey: true }), true)).toEqual({ accelerator: 'Command+Control+K' });
    expect(acceleratorFromKey(key('Digit1', { metaKey: true }), false)).toEqual({ accelerator: 'Super+1' });
    expect(acceleratorFromKey(key('F13'), true)).toEqual({ accelerator: 'F13' });
    expect(acceleratorFromKey(key('Semicolon', { ctrlKey: true }), false)).toEqual({ accelerator: 'Control+;' });
  });

  it('waits while only modifiers are down', () => {
    expect(acceleratorFromKey(key('AltLeft', { altKey: true }), true)).toEqual({ pending: true });
    expect(acceleratorFromKey(key('MetaRight', { metaKey: true }), true)).toEqual({ pending: true });
  });

  it('refuses keys that would break typing, and keys it cannot name', () => {
    expect(acceleratorFromKey(key('KeyA'), true)).toHaveProperty('error');
    expect(acceleratorFromKey(key('KeyA', { shiftKey: true }), true)).toHaveProperty('error');
    expect(acceleratorFromKey(key('IntlYen', { altKey: true }), true)).toHaveProperty('error');
  });
});

describe('formatAccelerator', () => {
  it('uses the names on the keyboard', () => {
    expect(formatAccelerator('Alt+Shift+Space', true)).toBe('Option+Shift+Space');
    expect(formatAccelerator('CommandOrControl+K', true)).toBe('Command+K');
    expect(formatAccelerator('CommandOrControl+K', false)).toBe('Control+K');
    expect(formatAccelerator('Super+1', false)).toBe('Windows+1');
  });
});
