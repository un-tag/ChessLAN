// Game sounds synthesized at startup (no sample files, works offline).
//
// A piece landing on a wooden board is an impulse exciting a few damped,
// inharmonic resonances: a sharp broadband click (the contact) plus short
// modes from roughly 200 Hz to 3 kHz (the wood). That's modelled directly as
// a filtered noise transient plus exponentially decaying partials. Chimes use
// small-bell partials (1, 2, 2.76, 5.4 × the fundamental).
import { get } from "./state/store";

interface Mode {
  freq: number;
  amp: number;
  decayMs: number; // time constant τ: amplitude falls to 1/e after this long
}

interface Strike {
  atMs: number;
  modes: Mode[];
  click: number; // transient loudness
  clickMs?: number;
  pitch?: number; // multiplies every mode frequency
}

const WOOD: Mode[] = [
  { freq: 240, amp: 0.55, decayMs: 16 },
  { freq: 585, amp: 0.4, decayMs: 11 },
  { freq: 1130, amp: 0.28, decayMs: 7 },
  { freq: 2240, amp: 0.16, decayMs: 4 },
];
const CLACK: Mode[] = [
  { freq: 420, amp: 0.45, decayMs: 13 },
  { freq: 1270, amp: 0.4, decayMs: 8 },
  { freq: 2650, amp: 0.3, decayMs: 5 },
  { freq: 3900, amp: 0.14, decayMs: 3 },
];
const bell = (freq: number, amp: number, decayMs: number): Mode[] => [
  { freq, amp, decayMs },
  { freq: freq * 2, amp: amp * 0.5, decayMs: decayMs * 0.6 },
  { freq: freq * 2.76, amp: amp * 0.35, decayMs: decayMs * 0.4 },
  { freq: freq * 5.4, amp: amp * 0.15, decayMs: decayMs * 0.2 },
];

function synthesize(rate: number, strikes: Strike[], gain: number): Float32Array<ArrayBuffer> {
  const lengthMs = Math.max(...strikes.map((s) => s.atMs + 6 * Math.max(...s.modes.map((m) => m.decayMs), 8)));
  const out = new Float32Array(Math.ceil((lengthMs / 1000) * rate));
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (const s of strikes) {
    const start = Math.round((s.atMs / 1000) * rate);
    const pitch = s.pitch ?? 1;
    for (const m of s.modes) {
      const w = (2 * Math.PI * m.freq * pitch) / rate;
      const k = Math.exp(-1000 / (m.decayMs * rate));
      let env = m.amp;
      for (let i = start; i < out.length && env > 1e-4; i++, env *= k) {
        // 0.3 ms attack ramp keeps the onset crisp but click-free.
        const attack = Math.min(1, (i - start) / (rate * 0.0003));
        out[i] += Math.sin(w * (i - start)) * env * attack;
      }
    }
    // Contact click: white noise, first-differenced (high-passed), ~2 ms.
    const clickLen = Math.round(((s.clickMs ?? 2) / 1000) * rate);
    let prev = 0;
    for (let i = 0; i < clickLen * 4 && start + i < out.length; i++) {
      const n = noise();
      out[start + i] += (n - prev) * s.click * Math.exp(-i / clickLen);
      prev = n;
    }
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const scale = peak ? gain / peak : 0;
  for (let i = 0; i < out.length; i++) out[i] *= scale;
  return out;
}

const SPECS = {
  move: { gain: 0.8, strikes: [{ atMs: 0, modes: WOOD, click: 0.5 }] },
  capture: {
    gain: 0.95,
    strikes: [
      { atMs: 0, modes: CLACK, click: 0.8 },
      { atMs: 22, modes: WOOD, click: 0.4, pitch: 0.9 },
    ],
  },
  castle: {
    gain: 0.8,
    strikes: [
      { atMs: 0, modes: WOOD, click: 0.5 },
      { atMs: 95, modes: WOOD, click: 0.45, pitch: 0.92 },
    ],
  },
  check: {
    gain: 0.85,
    strikes: [
      { atMs: 0, modes: CLACK, click: 0.6 },
      { atMs: 10, modes: bell(1568, 0.5, 110), click: 0 },
    ],
  },
  promote: {
    gain: 0.8,
    strikes: [
      { atMs: 0, modes: WOOD, click: 0.5 },
      { atMs: 40, modes: bell(1319, 0.35, 120), click: 0 },
      { atMs: 140, modes: bell(1760, 0.35, 160), click: 0 },
    ],
  },
  start: {
    gain: 0.6,
    strikes: [
      { atMs: 0, modes: bell(1047, 0.5, 220), click: 0 },
      { atMs: 150, modes: bell(1568, 0.5, 320), click: 0 },
    ],
  },
  end: {
    gain: 0.6,
    strikes: [
      { atMs: 0, modes: bell(1568, 0.5, 220), click: 0 },
      { atMs: 170, modes: bell(1047, 0.55, 420), click: 0 },
    ],
  },
  notify: {
    gain: 0.75,
    strikes: [
      { atMs: 0, modes: bell(1047, 0.5, 200), click: 0 },
      { atMs: 120, modes: bell(1319, 0.5, 200), click: 0 },
      { atMs: 240, modes: bell(1568, 0.55, 380), click: 0 },
    ],
  },
  chat: { gain: 0.4, strikes: [{ atMs: 0, modes: bell(1319, 0.5, 140), click: 0 }] },
  lowTime: {
    gain: 0.45,
    strikes: [{ atMs: 0, modes: [{ freq: 3100, amp: 0.5, decayMs: 4 }], click: 0.7, clickMs: 1 }],
  },
  premove: { gain: 0.35, strikes: [{ atMs: 0, modes: WOOD, click: 0.6, pitch: 1.5 }] },
  illegal: {
    gain: 0.6,
    strikes: [{ atMs: 0, modes: [{ freq: 150, amp: 0.6, decayMs: 45 }, { freq: 330, amp: 0.3, decayMs: 25 }], click: 0.2 }],
  },
} satisfies Record<string, { gain: number; strikes: Strike[] }>;

type SoundName = keyof typeof SPECS;

let ctx: AudioContext | null = null;
const buffers = new Map<SoundName, AudioBuffer>();

function audio(): AudioContext | null {
  if (!ctx) {
    try {
      ctx = new AudioContext({ latencyHint: "interactive" });
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function buffer(name: SoundName): AudioBuffer | null {
  const ac = audio();
  if (!ac) return null;
  let buf = buffers.get(name);
  if (!buf) {
    const data = synthesize(ac.sampleRate, SPECS[name].strikes, SPECS[name].gain);
    buf = ac.createBuffer(1, data.length, ac.sampleRate);
    buf.copyToChannel(data, 0);
    buffers.set(name, buf);
  }
  return buf;
}

function play(name: SoundName): void {
  const { prefs } = get();
  if (!prefs.sound) return;
  const buf = buffer(name);
  if (!buf || !ctx) return;
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = prefs.volume;
  src.buffer = buf;
  src.connect(gain).connect(ctx.destination);
  src.start();
}

export const sounds = Object.fromEntries(
  (Object.keys(SPECS) as SoundName[]).map((n) => [n, () => play(n)]),
) as Record<SoundName, () => void>;

/** chess.com precedence: check, then promotion, castling, capture, plain move. */
export function moveSound(m: { san: string; captured?: string; castle?: string; promotion?: string }): void {
  if (m.san.endsWith("+") || m.san.endsWith("#")) sounds.check();
  else if (m.promotion) sounds.promote();
  else if (m.castle) sounds.castle();
  else if (m.captured) sounds.capture();
  else sounds.move();
}

/** Audio may only start after a user gesture; also pre-renders every sound. */
export function unlockAudio(): void {
  if (!audio()) return;
  for (const n of Object.keys(SPECS) as SoundName[]) buffer(n);
}
