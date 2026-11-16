import { describe, it, expect } from 'vitest';
import type { Http, HttpRequest } from '../src/voice/http.js';
import { elevenLabsVoices, sarvamVoices, sonioxVoices } from '../src/voice/voices.js';

/** A fake Http that answers each call with the next queued JSON body. */
function fakeHttp(bodies: Array<{ status?: number; json: unknown }>): { http: Http; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const http: Http = async (req) => {
    calls.push(req);
    const next = bodies.shift() ?? { json: {} };
    return { status: next.status ?? 200, text: JSON.stringify(next.json), arrayBuffer: new ArrayBuffer(0) };
  };
  return { http, calls };
}

describe('elevenLabsVoices', () => {
  it('lists voices across pages with the key header and readable labels', async () => {
    const { http, calls } = fakeHttp([
      { json: { voices: [{ voice_id: 'a1', name: 'Alice', labels: { gender: 'female', accent: 'british' } }, { name: 'no id' }], has_more: true, next_page_token: 'p2' } },
      { json: { voices: [{ voice_id: 'b2', name: 'Bob', labels: {} }], has_more: false } },
    ]);
    const voices = await elevenLabsVoices(http, 'k');
    expect(voices).toEqual([{ id: 'a1', label: 'Alice (female, british)' }, { id: 'b2', label: 'Bob' }]);
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v2/voices?page_size=100');
    expect(calls[0].headers).toEqual({ 'xi-api-key': 'k' });
    expect(calls[1].url).toContain('next_page_token=p2');
  });

  it('explains a rejected key', async () => {
    const { http } = fakeHttp([{ status: 401, json: {} }]);
    await expect(elevenLabsVoices(http, 'bad')).rejects.toThrow('ElevenLabs rejected the API key');
  });
});

describe('sonioxVoices', () => {
  it('lists shared voices for the model, following the cursor', async () => {
    const { http, calls } = fakeHttp([
      { json: { voices: [{ id: 'Adrian', gender: 'male', accent: 'american' }], next_page_cursor: 'c2' } },
      { json: { voices: [{ id: 'Maya', gender: 'female', accent: 'middle_eastern' }], next_page_cursor: null } },
    ]);
    const voices = await sonioxVoices(http, 'k', 'tts-rt-v2');
    expect(voices).toEqual([{ id: 'Adrian', label: 'Adrian (male, american)' }, { id: 'Maya', label: 'Maya (female, middle eastern)' }]);
    expect(calls[0].url).toBe('https://api.soniox.com/v1/shared-voices?model=tts-rt-v2&limit=200');
    expect(calls[0].headers).toEqual({ Authorization: 'Bearer k' });
    expect(calls[1].url).toContain('cursor=c2');
  });

  it('stops after a bounded number of pages', async () => {
    const pages = Array.from({ length: 10 }, (_, i) => ({ json: { voices: [{ id: `v${i}` }], next_page_cursor: 'more' } }));
    const { http, calls } = fakeHttp(pages);
    expect(await sonioxVoices(http, 'k', 'm')).toHaveLength(5);
    expect(calls).toHaveLength(5);
  });
});

describe('sarvamVoices', () => {
  it('knows the bulbul:v3 speakers and labels them by gender', () => {
    const v = sarvamVoices('bulbul:v3');
    expect(v).toHaveLength(37);
    expect(v).toContainEqual({ id: 'shubh', label: 'Shubh (male)' });
    expect(v).toContainEqual({ id: 'ishita', label: 'Ishita (female)' });
  });

  it('returns nothing for a model whose speakers it does not know', () => {
    expect(sarvamVoices('bulbul:v4-flash')).toEqual([]);
  });
});
