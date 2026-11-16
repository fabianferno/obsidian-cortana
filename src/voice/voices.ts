// voice/voices.ts - the voices a cloud provider offers, for the settings pickers.
//
// ElevenLabs and Soniox list them through their APIs with the user's key.
// Sarvam has no listing endpoint, so its speakers come from its docs.

import type { Http } from './http.js';
import { asArray, asObject, asString, parseJson } from '../utils/json.js';

export interface VoiceOption {
  id: string;
  /** Shown in the dropdown. */
  label: string;
}

/** Pages fetched at most, so a huge library cannot stall the settings tab. */
const MAX_PAGES = 5;

async function getJson(http: Http, url: string, headers: Record<string, string>, provider: string): Promise<Record<string, unknown>> {
  const res = await http({ url, method: 'GET', headers });
  if (res.status === 401 || res.status === 403) throw new Error(`${provider} rejected the API key`);
  if (res.status >= 400) throw new Error(`${provider} returned HTTP ${res.status}`);
  return asObject(parseJson(res.text));
}

/** "Name (female, british)" from whichever details are present. */
function withDetails(name: string, details: Array<string | undefined>): string {
  const extra = details.filter((d): d is string => !!d && d.trim() !== '').map(d => d.replace(/_/g, ' '));
  return extra.length ? `${name} (${extra.join(', ')})` : name;
}

/** Every voice in the user's ElevenLabs library, premade voices included. */
export async function elevenLabsVoices(http: Http, apiKey: string): Promise<VoiceOption[]> {
  const out: VoiceOption[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `https://api.elevenlabs.io/v2/voices?page_size=100${token ? `&next_page_token=${encodeURIComponent(token)}` : ''}`;
    const data = await getJson(http, url, { 'xi-api-key': apiKey }, 'ElevenLabs');
    for (const v of asArray(data.voices)) {
      const o = asObject(v);
      const id = asString(o.voice_id);
      if (!id) continue;
      const labels = asObject(o.labels);
      out.push({ id, label: withDetails(asString(o.name) ?? id, [asString(labels.gender), asString(labels.accent)]) });
    }
    token = data.has_more === true ? asString(data.next_page_token) : undefined;
    if (!token) break;
  }
  return out;
}

/** Soniox's shared voices for a TTS model. */
export async function sonioxVoices(http: Http, apiKey: string, model: string): Promise<VoiceOption[]> {
  const out: VoiceOption[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `https://api.soniox.com/v1/shared-voices?model=${encodeURIComponent(model)}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const data = await getJson(http, url, { Authorization: `Bearer ${apiKey}` }, 'Soniox');
    for (const v of asArray(data.voices)) {
      const o = asObject(v);
      const id = asString(o.id);
      if (id) out.push({ id, label: withDetails(id, [asString(o.gender), asString(o.accent)]) });
    }
    cursor = asString(data.next_page_cursor);
    if (!cursor) break;
  }
  return out;
}

/** Sarvam speakers per model, from docs.sarvam.ai (no listing endpoint exists). */
const SARVAM_SPEAKERS: Record<string, { male: string[]; female: string[] }> = {
  'bulbul:v3': {
    male: ['shubh', 'aditya', 'rahul', 'rohan', 'amit', 'dev', 'ratan', 'varun', 'manan', 'sumit', 'kabir', 'aayan', 'ashutosh', 'advait', 'anand', 'tarun', 'sunny', 'mani', 'gokul', 'vijay', 'mohit', 'rehan', 'soham'],
    female: ['ritu', 'priya', 'neha', 'pooja', 'simran', 'kavya', 'ishita', 'shreya', 'roopa', 'tanya', 'shruti', 'suhani', 'kavitha', 'rupali'],
  },
  'bulbul:v2': {
    male: ['abhilash', 'karun', 'hitesh'],
    female: ['anushka', 'manisha', 'vidya', 'arya'],
  },
};

/** Sarvam speakers for a model, or [] when the model's list is not known. */
export function sarvamVoices(model: string): VoiceOption[] {
  const s = SARVAM_SPEAKERS[model.trim()];
  if (!s) return [];
  const cap = (n: string) => n.charAt(0).toUpperCase() + n.slice(1);
  return [
    ...s.female.map(id => ({ id, label: `${cap(id)} (female)` })),
    ...s.male.map(id => ({ id, label: `${cap(id)} (male)` })),
  ].sort((a, b) => a.label.localeCompare(b.label));
}
