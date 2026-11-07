import type { Settings } from '@/types/models';

let actx: AudioContext | undefined;

/** Short synthesized chimes, so no audio files ship with the app. */
export function playSound(kind: 'complete' | 'failed' | 'queueDone', s: Settings['sounds']) {
  if (!s || !s[kind]) return;
  actx = actx || new AudioContext();
  const notes = { complete: [660, 880, 1320], failed: [440, 330], queueDone: [523, 659, 784, 1046] }[kind];
  notes.forEach((f, i) => {
    const o = actx!.createOscillator();
    const g = actx!.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    const t = actx!.currentTime + i * 0.12;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(s.volume ?? 0.4, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g).connect(actx!.destination);
    o.start(t);
    o.stop(t + 0.3);
  });
}
