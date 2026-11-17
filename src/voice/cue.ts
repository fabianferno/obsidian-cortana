// voice/cue.ts - short tones for when Cortana starts and stops listening, so
// the system-wide shortcut gives feedback while Obsidian is in the background.

const TONES: Record<'start' | 'stop', number[]> = {
  start: [660, 880],
  stop: [880, 520],
};

export function playCue(kind: 'start' | 'stop'): void {
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    const t0 = ctx.currentTime;
    TONES[kind].forEach((freq, i) => {
      const at = t0 + i * 0.09;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.15, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.08);
      osc.start(at);
      osc.stop(at + 0.09);
    });
    window.setTimeout(() => void ctx.close(), 400);
  } catch {
    // No audio output: the panel still shows the state.
  }
}
