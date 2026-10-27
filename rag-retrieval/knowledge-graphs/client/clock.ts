// The scene clock. Scene time is "script time": every beat, highlight, edit and auto-scroll is
// written in script milliseconds at 1× speed. The clock maps wall time to script time through one
// speed multiplier, so 0.5× doubles every wall-clock delay. Changing speed keeps the current position.

export const SPEEDS = [0.5, 0.75, 1, 1.5] as const;
export type Speed = (typeof SPEEDS)[number];

export function parseSpeed(value: string | null | undefined): Speed | null {
  const n = Number(value);
  return (SPEEDS as readonly number[]).includes(n) ? (n as Speed) : null;
}

export class SceneClock {
  private base: number;
  private offset = 0;

  constructor(
    private readonly now: () => number,
    public speed: number = 1,
  ) {
    this.base = now();
  }

  /** Restarts at script time 0 (a new scene). */
  restart(): void {
    this.base = this.now();
    this.offset = 0;
  }

  /** Current script time, in ms. */
  time(): number {
    return this.offset + (this.now() - this.base) * this.speed;
  }

  /** Changes speed without moving the current position. */
  setSpeed(speed: number): void {
    this.offset = this.time();
    this.base = this.now();
    this.speed = speed;
  }

  /** Wall-clock milliseconds from now until script time `at` (0 if already past). */
  wallUntil(at: number): number {
    return Math.max(0, (at - this.time()) / this.speed);
  }
}
