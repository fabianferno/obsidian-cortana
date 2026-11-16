import { describe, it, expect } from 'vitest';
import { CueStreamFilter, keepAllowedCues, stripCues } from '../src/speech/cues.js';
import { speechRules } from '../src/brain/prompt-builder.js';
import { elevenLabsReadsCues, sonioxReadsCues } from '../src/voice/cloud.js';

describe('stripCues', () => {
  it('removes cues and the space after them', () => {
    expect(stripCues('[warm] Good morning, Chief. [stern] Finish it today.')).toBe('Good morning, Chief. Finish it today.');
    expect(stripCues('Done [sighs].')).toBe('Done.');
  });

  it('leaves links, footnotes and checkboxes alone', () => {
    const text = 'See [[Garden Project]], [the docs](https://x.y) and note [1]. - [x] done - [ ] open';
    expect(stripCues(text)).toBe(text);
  });
});

describe('keepAllowedCues', () => {
  it('keeps known cues and drops the rest so they are not read aloud', () => {
    expect(keepAllowedCues('[warm] Hi. [mysteriously] Ready? [pause] Go.')).toBe('[warm] Hi. Ready? [pause] Go.');
  });
});

describe('CueStreamFilter', () => {
  it('holds back a tag split across chunks', () => {
    const f = new CueStreamFilter();
    const out = ['[wa', 'rm] Good ', 'morning. [s', 'ighs] Okay [', '1] and [unclosed'].map(c => f.push(c)).join('') + f.flush();
    expect(out).toBe('Good morning. Okay [1] and [unclosed');
  });

  it('does not hold text back forever after a lone bracket', () => {
    const f = new CueStreamFilter();
    expect(f.push('a [ ' + 'x'.repeat(40))).toBe('a [ ' + 'x'.repeat(40));
  });
});

describe('which voices read cues', () => {
  it('knows the models', () => {
    expect(sonioxReadsCues('tts-rt-v2')).toBe(true);
    expect(sonioxReadsCues('tts-rt-v1')).toBe(false);
    expect(elevenLabsReadsCues('eleven_v3')).toBe(true);
    expect(elevenLabsReadsCues('eleven_flash_v2_5')).toBe(false);
  });
});

describe('speechRules', () => {
  it('is empty for a plain voice', () => {
    expect(speechRules()).toBe('');
    expect(speechRules({ cues: false })).toBe('');
  });

  it('lists the allowed cues for a voice that reads them', () => {
    const r = speechRules({ cues: true });
    expect(r).toContain('[warm]');
    expect(r).toContain('[chuckles]');
    expect(r).toContain('always in English');
  });

  it('asks for native script for an Indian language voice', () => {
    const r = speechRules({ cues: false, indicLanguage: 'Hindi' });
    expect(r).toContain('Hindi words in their own script');
    expect(r).toContain('।');
    expect(r).not.toContain('[warm]');
  });
});
