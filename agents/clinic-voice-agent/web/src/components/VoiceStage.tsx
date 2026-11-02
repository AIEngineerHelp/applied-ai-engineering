import { useEffect, useRef } from "react";

export type Phase = "idle" | "connecting" | "live" | "ended";

const BARS = 28;

type Meter = { analyser: AnalyserNode; data: Uint8Array<ArrayBuffer> };

function meter(ctx: AudioContext, track: MediaStreamTrack): Meter {
  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 128;
  analyser.smoothingTimeConstant = 0.78;
  source.connect(analyser); // not to ctx.destination: the <audio> element already plays it
  return { analyser, data: new Uint8Array(analyser.frequencyBinCount) };
}

/** Speech energy sits in the low bins; spread the first ~third of the spectrum over the bars. */
function bands(m: Meter, out: number[]) {
  m.analyser.getByteFrequencyData(m.data);
  const usable = Math.floor(m.data.length / 3);
  let sum = 0;
  for (let i = 0; i < BARS; i++) {
    // Mirror around the centre so the waveform reads as one voice, loudest in the middle.
    const fromCentre = Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2);
    const bin = Math.floor(fromCentre * (usable - 1));
    const v = m.data[bin] / 255;
    out[i] = v;
    sum += v;
  }
  return sum / BARS;
}

/**
 * The agent, drawn from what it is doing: still when idle, breathing while it listens,
 * dots while it thinks, and a waveform from its real audio while it speaks. The caller's
 * microphone level shows underneath. Levels are read with the Web Audio API and written
 * straight to the DOM each frame, so the page never re-renders at 60 fps.
 */
export function VoiceStage(props: {
  phase: Phase;
  state: string;
  initial: string;
  agentTrack: MediaStreamTrack | null;
  micTrack: MediaStreamTrack | null;
  startedAt: number | null;
}) {
  const { phase, state, initial, agentTrack, micTrack, startedAt } = props;
  const barsRef = useRef<HTMLDivElement>(null);
  const orbRef = useRef<HTMLDivElement>(null);
  const micRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<HTMLSpanElement>(null);
  const live = phase === "live";
  const speaking = live && state === "speaking";
  const thinking = live && state === "thinking";
  const listening = live && !speaking && !thinking;

  useEffect(() => {
    if (!live) return;
    const ctx = new AudioContext();
    void ctx.resume();
    const agent = agentTrack ? meter(ctx, agentTrack) : null;
    const mic = micTrack ? meter(ctx, micTrack) : null;
    const levels = new Array<number>(BARS).fill(0);
    const micLevels = new Array<number>(BARS).fill(0);
    const bars = Array.from(barsRef.current?.children ?? []) as HTMLElement[];
    let frame = 0;
    const draw = () => {
      const level = agent ? bands(agent, levels) : 0;
      bars.forEach((b, i) => {
        b.style.transform = `scaleY(${0.08 + levels[i] * 0.92})`;
      });
      if (orbRef.current) orbRef.current.style.transform = `scale(${1 + Math.min(level * 0.35, 0.12)})`;
      if (micRef.current) micRef.current.style.transform = `scaleX(${mic ? Math.min(1, bands(mic, micLevels) * 2.2) : 0})`;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      void ctx.close();
      bars.forEach((b, i) => (b.style.transform = `scaleY(${restHeight(i)})`));
      if (orbRef.current) orbRef.current.style.transform = "";
      if (micRef.current) micRef.current.style.transform = "scaleX(0)";
    };
  }, [live, agentTrack, micTrack]);

  useEffect(() => {
    if (!startedAt) return;
    const tick = () => {
      const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      if (timerRef.current) timerRef.current.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };
    tick();
    if (!live) return;
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [startedAt, live]);

  return (
    <div className="relative px-6 pt-12 pb-2">
      <div className="absolute top-4 left-5 flex items-center gap-2 text-[12px] tracking-wide text-ink-3 uppercase">
        <span className={`h-2 w-2 rounded-full transition-colors ${live ? "live-dot bg-bad" : phase === "connecting" ? "live-dot bg-warn" : "bg-rule-2"}`} />
        {live ? "Live" : phase === "connecting" ? "Connecting" : phase === "ended" ? "Ended" : "Not connected"}
      </div>
      <div className="absolute top-4 right-5 font-mono text-[13px] text-ink-2 tabular-nums">
        <span ref={timerRef}>{startedAt ? "" : "0:00"}</span>
      </div>

      <div className="relative mx-auto mt-2 grid h-40 w-40 place-items-center">
        {listening && (
          <>
            <span className="ripple absolute inset-3 rounded-full border border-accent" />
            <span className="ripple-late absolute inset-3 rounded-full border border-accent" />
          </>
        )}
        {phase === "connecting" && <span className="absolute inset-2 animate-spin rounded-full border-2 border-rule border-t-accent" />}
        <div
          ref={orbRef}
          className={`relative grid h-28 w-28 place-items-center rounded-full transition-[background-color,color,transform] duration-500 ease-[var(--ease-out-soft)] ${
            live ? "bg-accent text-paper" : phase === "connecting" ? "bg-accent-soft text-accent" : "bg-rule text-ink-3"
          } ${listening ? "breathe" : ""}`}
        >
          <span className="font-serif text-[44px] leading-none">{initial}</span>
          {thinking && (
            <span className="absolute bottom-5 flex gap-1">
              {[0, 1, 2].map((i) => (
                <span key={i} className="think-dot h-1.5 w-1.5 rounded-full bg-paper" style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </span>
          )}
        </div>
      </div>

      <div ref={barsRef} className="mx-auto mt-3 flex h-14 max-w-md items-center justify-center gap-[3px]" aria-hidden>
        {Array.from({ length: BARS }, (_, i) => (
          <span
            key={i}
            className={`h-full w-[5px] rounded-full transition-colors duration-500 ${speaking ? "bg-accent" : live ? "bg-accent-2/60" : "bg-rule-2"}`}
            style={{ transform: `scaleY(${restHeight(i)})` }}
          />
        ))}
      </div>

      <div className="mx-auto mt-5 flex max-w-xs items-center gap-3 text-[12px] text-ink-3">
        <span className="w-8 shrink-0">You</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-rule">
          <div ref={micRef} className="h-full origin-left rounded-full bg-ink-2 transition-transform duration-75" style={{ transform: "scaleX(0)" }} />
        </div>
      </div>
    </div>
  );
}

/** A soft resting silhouette so the waveform has a shape before anyone speaks. */
function restHeight(i: number) {
  const x = (i - (BARS - 1) / 2) / ((BARS - 1) / 2);
  return 0.12 + 0.3 * Math.cos((x * Math.PI) / 2) ** 2;
}
