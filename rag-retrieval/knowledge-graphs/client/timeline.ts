// A scene's clock. Every scene is drawn as a pure function of its time t, so
// it can be played, paused, stepped beat by beat, skipped to the end, or
// frozen at a given moment (?t=2.4) for screenshots.

export const ease = {
  out: (x: number) => 1 - Math.pow(1 - clamp01(x), 3),
  inOut: (x: number) => {
    const t = clamp01(x);
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  },
  outBack: (x: number) => {
    const t = clamp01(x);
    const c = 1.4;
    return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
  },
};

export function clamp01(x: number) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Progress of t through [start, start + length], 0..1. */
export const span = (t: number, start: number, length: number) => clamp01((t - start) / length);

export interface Beat {
  at: number;
  caption: string;
}

export class Sequence {
  private startedAt = performance.now();
  private pausedAt: number | null = null;

  constructor(
    readonly duration: number,
    readonly beats: Beat[],
    private frozen: number | null = null,
  ) {}

  get t(): number {
    if (this.frozen !== null) return Math.min(this.frozen, this.duration);
    const now = this.pausedAt ?? performance.now();
    return Math.min(this.duration, (now - this.startedAt) / 1000);
  }
  get playing() {
    return this.frozen === null && this.pausedAt === null && this.t < this.duration;
  }
  get done() {
    return this.t >= this.duration;
  }
  /** Index of the beat t is in. */
  get beat(): number {
    let i = 0;
    this.beats.forEach((b, j) => {
      if (this.t >= b.at) i = j;
    });
    return i;
  }
  get caption() {
    return this.beats[this.beat]?.caption ?? "";
  }

  seek(t: number) {
    this.frozen = null;
    const clamped = Math.max(0, Math.min(this.duration, t));
    const now = performance.now();
    this.startedAt = now - clamped * 1000;
    if (this.pausedAt !== null) this.pausedAt = now;
  }
  play() {
    if (this.done) this.seek(0);
    if (this.pausedAt !== null) {
      this.startedAt += performance.now() - this.pausedAt;
      this.pausedAt = null;
    }
    this.frozen = null;
  }
  pause() {
    if (this.pausedAt === null) this.pausedAt = performance.now();
  }
  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }
  /** Jump to the start of the next beat (or the end), and hold there. */
  next() {
    const b = this.beats[this.beat + 1];
    this.seek(b ? b.at : this.duration);
    this.pause();
  }
  prev() {
    const cur = this.beats[this.beat];
    // Within the first half second of a beat, go to the previous one.
    const target = this.t - cur.at < 0.5 ? this.beats[Math.max(0, this.beat - 1)].at : cur.at;
    this.seek(target);
    this.pause();
  }
  skip() {
    this.seek(this.duration);
  }
}
