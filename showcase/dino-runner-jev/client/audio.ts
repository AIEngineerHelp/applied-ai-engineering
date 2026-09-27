// Music and sound effects, synthesised with the Web Audio API: no audio files,
// nothing to license. The tune is an original loop over a I–vi–IV–V
// progression; sound effects are short envelopes on simple oscillators.

const mtof = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const STORAGE_KEY = "dino-jev-muted";

// Four chords (C, Am, F, G): bass root and triad for the off-beat stabs.
const CHORDS = [
  { root: 48, triad: [60, 64, 67] },
  { root: 45, triad: [57, 60, 64] },
  { root: 41, triad: [53, 57, 60] },
  { root: 43, triad: [55, 59, 62] },
];
// Melody: eight eighth-notes per bar, null = rest. Two phrases, played A A B A.
const A = [
  [76, null, 79, null, 81, 79, 76, null],
  [84, null, 81, null, 79, null, 76, null],
  [81, null, 84, 81, 79, null, 77, null],
  [79, null, 74, null, 79, 81, 83, null],
];
const B = [
  [72, null, 76, 79, 84, null, 79, null],
  [81, null, 76, null, 72, null, 69, null],
  [77, 81, 84, null, 81, null, 77, null],
  [79, null, 83, null, 86, null, null, null],
];
const SONG = [A, A, B, A];
const STEPS = SONG.length * 4 * 8;

function readMuted() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function createAudio() {
  let ctx: AudioContext | null = null;
  let master: GainNode;
  let music: GainNode;
  let sfx: GainNode;
  let noise: AudioBuffer;
  let muted = readMuted();
  let playing = false;
  let step = 0;
  let nextTime = 0;
  let timer = 0;
  let tempo = 120;

  /** Created lazily: browsers only allow audio after a user gesture. */
  function ensure() {
    if (ctx) return ctx;
    const Context = window.AudioContext || (window as any).webkitAudioContext;
    if (!Context) return null;
    ctx = new Context();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -18;
    glue.ratio.value = 3;
    glue.connect(master);
    master.connect(ctx.destination);
    music = ctx.createGain();
    music.gain.value = 0.16;
    music.connect(glue);
    sfx = ctx.createGain();
    sfx.gain.value = 0.3;
    sfx.connect(glue);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return ctx;
  }

  function tone(
    bus: GainNode,
    { freq, start, dur, type = "square", vol = 0.3, attack = 0.005, glideTo, lowpass }: {
      freq: number; start: number; dur: number; type?: OscillatorType; vol?: number; attack?: number; glideTo?: number; lowpass?: number;
    },
  ) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, start + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(vol, start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    let node: AudioNode = osc;
    if (lowpass) {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = lowpass;
      osc.connect(filter);
      node = filter;
    }
    node.connect(gain);
    gain.connect(bus);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  function hiss(bus: GainNode, { start, dur, vol, type, freq }: { start: number; dur: number; vol: number; type: BiquadFilterType; freq: number }) {
    const source = ctx.createBufferSource();
    source.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(bus);
    source.start(start, Math.random() * 0.5);
    source.stop(start + dur + 0.02);
  }

  function playStep(index: number, time: number) {
    const eighth = 60 / tempo / 2;
    const bar = Math.floor(index / 8);
    const beat = index % 8;
    const chord = CHORDS[bar % 4];
    const note = SONG[Math.floor(bar / 4) % SONG.length][bar % 4][beat];
    // Bass: bouncing root and octave.
    if (beat % 2 === 0) tone(music, { freq: mtof(chord.root + (beat % 4 === 2 ? 12 : 0)), start: time, dur: eighth * 0.9, type: "triangle", vol: 0.55 });
    // Off-beat chord stabs give the bouncy, cartoon feel.
    else for (const n of chord.triad) tone(music, { freq: mtof(n), start: time, dur: eighth * 0.45, vol: 0.07, lowpass: 1800 });
    if (note !== null) tone(music, { freq: mtof(note), start: time, dur: eighth * 0.85, vol: 0.12, lowpass: 2800 });
    // Light drums: kick on 1 and 3, snare on 2 and 4, soft hats on every eighth.
    if (beat === 0 || beat === 4) tone(music, { freq: 150, glideTo: 45, start: time, dur: 0.14, type: "sine", vol: 0.8 });
    if (beat === 2 || beat === 6) hiss(music, { start: time, dur: 0.12, vol: 0.35, type: "bandpass", freq: 1800 });
    hiss(music, { start: time, dur: 0.03, vol: 0.12, type: "highpass", freq: 7000 });
  }

  function schedule() {
    // Look ahead ~120 ms so timing stays tight even if the main thread stalls.
    while (nextTime < ctx.currentTime + 0.12) {
      playStep(step, nextTime);
      nextTime += 60 / tempo / 2;
      step = (step + 1) % STEPS;
    }
  }

  function startMusic() {
    if (!ensure() || playing) return;
    playing = true;
    step = 0;
    nextTime = ctx.currentTime + 0.05;
    schedule();
    timer = window.setInterval(schedule, 25);
  }
  function stopMusic() {
    playing = false;
    clearInterval(timer);
  }

  /** Short sound effects; skipped entirely while muted. */
  function effect(play: (now: number) => void) {
    if (muted || !ensure()) return;
    play(ctx.currentTime);
  }
  const sounds = {
    jump: () => effect((t) => tone(sfx, { freq: 320, glideTo: 780, start: t, dur: 0.14, vol: 0.35, lowpass: 3000 })),
    land: () => effect((t) => tone(sfx, { freq: 130, glideTo: 60, start: t, dur: 0.09, type: "sine", vol: 0.5 })),
    crash: () =>
      effect((t) => {
        tone(sfx, { freq: 420, glideTo: 70, start: t, dur: 0.45, type: "sawtooth", vol: 0.35, lowpass: 1400 });
        tone(sfx, { freq: 180, glideTo: 90, start: t, dur: 0.2, type: "sine", vol: 0.6 });
        hiss(sfx, { start: t, dur: 0.18, vol: 0.4, type: "lowpass", freq: 1200 });
      }),
    milestone: () =>
      effect((t) => {
        tone(sfx, { freq: mtof(88), start: t, dur: 0.12, type: "triangle", vol: 0.35 });
        tone(sfx, { freq: mtof(91), start: t + 0.1, dur: 0.22, type: "triangle", vol: 0.35 });
      }),
    pop: () => effect((t) => tone(sfx, { freq: 900, glideTo: 1300, start: t, dur: 0.05, type: "sine", vol: 0.18 })),
  };

  // Pause audio with the tab; the game loop pauses too.
  document.addEventListener("visibilitychange", () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend();
    else ctx.resume();
  });

  return {
    ...sounds,
    startMusic,
    stopMusic,
    /** Call from a user gesture (key press, click) to allow sound. */
    unlock() {
      if (ensure()?.state === "suspended") ctx.resume();
    },
    setTempo(bpm: number) {
      tempo = Math.max(90, Math.min(170, bpm));
    },
    get muted() {
      return muted;
    },
    setMuted(value: boolean) {
      muted = value;
      if (ctx) master.gain.setTargetAtTime(value ? 0 : 1, ctx.currentTime, 0.02);
      try {
        localStorage.setItem(STORAGE_KEY, String(value));
      } catch {}
    },
  };
}
