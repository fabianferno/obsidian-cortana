// speech/cues.ts - inline voice cues such as "[warm]" or "[chuckles]".
//
// Soniox (tts-rt-v2) and ElevenLabs (eleven_v3) read bracketed audio tags as
// directions for how to say the words that follow. The agent is told about a
// small set when the voice supports them. Cues are never shown in the panel,
// and any cue a voice cannot take is removed so it is not read aloud.

/** The cues Cortana may use. Kept short: a few well-placed tags beat many. */
export const CUE_TAGS = [
  'warm', 'calm', 'serious', 'stern', 'playful', 'excited', 'curious',
  'reassuringly', 'sincerely', 'softly', 'chuckles', 'laughs', 'sighs', 'pause',
] as const;

const ALLOWED = new Set<string>(CUE_TAGS);

/**
 * A bracketed tag of plain lowercase words. Wikilinks ([[Note]]), markdown
 * links ([text](url)), footnotes ([1]) and checkboxes ([x]) do not match.
 */
const TAG = /(?<!\[)\[([a-z][a-z' -]{1,30})\](?![\](])/g;
/** A tag plus the space after it, so "[warm] Hi" leaves "Hi". */
const TAG_SPACE = new RegExp(`${TAG.source}[ \\t]?`, 'g');
const TAG_AT_END = new RegExp(`${TAG.source}$`);

function tidy(text: string): string {
  return text.replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+/gm, '').replace(/[ \t]+([,.!?;:])/g, '$1');
}

/** Text with every cue removed, for the panel and for voices without cues. */
export function stripCues(text: string): string {
  return tidy(text.replace(TAG_SPACE, ''));
}

/** Text with only the allowed cues kept, for a voice that reads them. */
export function keepAllowedCues(text: string): string {
  return tidy(text.replace(TAG, (_tag, name: string) => (ALLOWED.has(name.trim()) ? `[${name.trim()}]` : '')));
}

/** Longest stretch held back while waiting for a "[" to close. */
const MAX_HOLD = 34;

/**
 * Streaming counterpart of stripCues: holds back an unclosed "[" so a tag split
 * across chunks ("[wa" + "rm] Hi") never flashes in the panel.
 */
export class CueStreamFilter {
  private pending = '';
  /** The last chunk ended on a tag, so its space starts the next one. */
  private eatSpace = false;

  push(chunk: string): string {
    const text = this.pending + chunk;
    this.pending = '';
    const open = text.lastIndexOf('[');
    if (open !== -1 && text.indexOf(']', open) === -1 && text.length - open <= MAX_HOLD) {
      this.pending = text.slice(open);
      return this.clean(text.slice(0, open));
    }
    return this.clean(text);
  }

  flush(): string {
    const rest = this.pending;
    this.pending = '';
    return this.clean(rest);
  }

  private clean(text: string): string {
    if (!text) return '';
    if (this.eatSpace) text = text.replace(/^[ \t]/, '');
    this.eatSpace = TAG_AT_END.test(text);
    return text.replace(TAG_SPACE, '');
  }
}
