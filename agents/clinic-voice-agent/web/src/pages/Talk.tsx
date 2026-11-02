import type { Participant, RemoteTrack, Room } from "livekit-client";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api, type CallEvent, type Config, type Fault } from "../api";
import { PageHeader } from "../components/ui";
import { EventRow } from "./CallDetail";
import { type Phase, VoiceStage } from "../components/VoiceStage";

type Line = { id: string; role: "caller" | "agent"; text: string; final: boolean };
type Who = "me" | "sample";

const AGENT_STATE_LABEL: Record<string, string> = {
  initializing: "Joining the call…",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  idle: "Listening",
};

const TRY = [
  { say: "I'd like to book an appointment for a sore throat.", shows: "pre-call record, slot search, booking" },
  { say: "Can I move my appointment to next week?", shows: "reschedule with an id the caller owns" },
  { say: "What are your hours on Saturday?", shows: "knowledge-base answer with a source" },
  { say: "I have chest pain.", shows: "the emergency guard takes over from the model" },
  { say: "I have a question about my bill.", shows: "transfer to billing" },
];

const SAVED = "clinic-voice-agent:me";

function loadMe(): { name: string; phone: string } {
  try {
    return { name: "", phone: "", ...JSON.parse(localStorage.getItem(SAVED) ?? "{}") };
  } catch {
    return { name: "", phone: "" };
  }
}

export function TalkPage({ config }: { config: Config | null }) {
  const [who, setWho] = useState<Who>("me");
  const [me, setMe] = useState(loadMe);
  const [sample, setSample] = useState<string>("+15550142201");
  const [pipeline, setPipeline] = useState<"realtime" | "cascade">("realtime");
  const [phase, setPhase] = useState<Phase>("idle");
  const [agentState, setAgentState] = useState("initializing");
  const [lines, setLines] = useState<Line[]>([]);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roomName, setRoomName] = useState<string | null>(null);
  const [agentTrack, setAgentTrack] = useState<MediaStreamTrack | null>(null);
  const [micTrack, setMicTrack] = useState<MediaStreamTrack | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // The agent streams each call-log event to the room; this is the call's trace, live.
  const [events, setEvents] = useState<CallEvent[]>([]);
  // On the hosted demo the fault switch travels with the call (dispatch metadata at the
  // start, a participant attribute mid-call), since there is no shared CRM server.
  const [fault, setFault] = useState<Partial<Fault>>({ mode: "none" });
  const hosted = config?.hosted ?? false;
  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (config) setPipeline(config.default_pipeline);
  }, [config]);

  useEffect(() => () => void roomRef.current?.disconnect(), []);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [lines]);

  const meValid = me.name.trim().length > 0 && me.phone.replace(/\D/g, "").length >= 7;
  const callingAs =
    who === "me" ? (me.name.trim() || "you") : (config?.callers.find((c) => c.phone === sample)?.name ?? "a sample patient");

  async function start(e?: FormEvent) {
    e?.preventDefault();
    if (who === "me" && !meValid) {
      setError("Enter your name and a phone number with the country code.");
      return;
    }
    setError(null);
    setLines([]);
    setAgentTrack(null);
    setMicTrack(null);
    setStartedAt(null);
    setEvents([]);
    setPhase("connecting");
    setAgentState("initializing");
    try {
      if (who === "me") {
        try {
          localStorage.setItem(SAVED, JSON.stringify(me));
        } catch {
          /* private window: nothing to remember */
        }
      }
      const crmFault = hosted && fault.mode !== "none" ? fault : undefined;
      const { url, token, room: name } =
        who === "me"
          ? await api.session(pipeline, me.phone, me.name, crmFault)
          : await api.session(pipeline, sample || null, undefined, crmFault);
      // Loaded on demand: the WebRTC client is most of the bundle and only this button needs it.
      const { Room, RoomEvent, Track } = await import("livekit-client");
      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;
      setRoomName(name);

      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind !== Track.Kind.Audio) return;
        audioRef.current?.appendChild(track.attach());
        setAgentTrack(track.mediaStreamTrack);
      });
      room.on(RoomEvent.ParticipantAttributesChanged, (changed: Record<string, string>, p: Participant) => {
        if (!p.isLocal && changed["lk.agent.state"]) setAgentState(changed["lk.agent.state"]);
      });
      room.on(RoomEvent.ParticipantDisconnected, (p: Participant) => {
        if (!p.isLocal) void room.disconnect();
      });
      room.on(RoomEvent.Disconnected, () => setPhase("ended"));
      room.on(RoomEvent.DataReceived, (payload: Uint8Array, _p?: Participant, _k?: unknown, topic?: string) => {
        if (topic !== "clinic.events") return;
        try {
          const e = JSON.parse(new TextDecoder().decode(payload)) as Omit<CallEvent, "seq">;
          setEvents((prev) => [...prev, { ...e, seq: prev.length + 1 }]);
        } catch {
          /* not one of ours */
        }
      });
      // Agents publish live transcripts on this topic, one stream per segment.
      room.registerTextStreamHandler("lk.transcription", async (reader, info) => {
        const id = reader.info.attributes?.["lk.segment_id"] ?? reader.info.id;
        const role: Line["role"] = info.identity === room.localParticipant.identity ? "caller" : "agent";
        let text = "";
        for await (const chunk of reader) {
          text += chunk;
          const final = reader.info.attributes?.["lk.transcription_final"] === "true";
          setLines((prev) => upsert(prev, { id, role, text, final }));
        }
      });

      await room.connect(url, token);
      await room.localParticipant.setMicrophoneEnabled(true);
      setMicTrack(room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack ?? null);
      setStartedAt(Date.now());
      setPhase("live");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
      void roomRef.current?.disconnect();
    }
  }

  async function hangUp() {
    await roomRef.current?.disconnect();
    setPhase("ended");
  }

  async function toggleMute() {
    const room = roomRef.current;
    if (!room) return;
    await room.localParticipant.setMicrophoneEnabled(muted);
    setMuted(!muted);
  }

  const ready = config?.gemini_key ?? false;
  const inCall = phase === "connecting" || phase === "live";
  const agentName = config?.clinic.agent_name ?? "Meera";

  const inputClass =
    "w-full rounded-lg border border-rule-2 bg-card px-3.5 py-2.5 text-[15px] text-ink transition-[border-color,box-shadow] outline-none placeholder:text-ink-3/70 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)]";

  return (
    <>
      <PageHeader
        title="Talk to the agent"
        lede={
          <>
            Call {agentName}, the front desk of a fictional clinic, from your browser. She looks you up by number, then books, moves
            or cancels a visit. Nothing is dialled: the call stays in this page.
          </>
        }
      />

      <section className="rise overflow-hidden rounded-2xl border border-rule bg-card shadow-[0_24px_60px_-40px_rgb(28_27_25/0.35)]">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          {/* The agent and the controls. */}
          <div className="flex flex-col border-b border-rule bg-paper/60 lg:border-r lg:border-b-0">
            <VoiceStage
              phase={phase}
              state={agentState}
              initial={agentName.slice(0, 1)}
              agentTrack={agentTrack}
              micTrack={micTrack}
              startedAt={startedAt}
            />
            <div className="px-6 pt-2 text-center">
              <div key={`${phase}-${agentState}`} className="rise font-serif text-[26px] leading-tight text-ink">
                {phase === "idle" && agentName}
                {phase === "connecting" && `Ringing ${agentName}…`}
                {phase === "live" && (AGENT_STATE_LABEL[agentState] ?? agentState)}
                {phase === "ended" && "Call ended"}
              </div>
              <div className="mt-1 text-[14px] text-ink-3">
                {phase === "idle" && "Front desk · Birchwood Family Clinic"}
                {phase === "connecting" && `Calling as ${callingAs}`}
                {phase === "live" && `On the line as ${callingAs}. Speak normally; you can interrupt.`}
                {phase === "ended" && (hosted ? "This call's trace is below." : "The full trace is in the call log.")}
              </div>
            </div>

            <div className="mt-auto px-6 pt-6 pb-6">
              {!inCall && (
                <form onSubmit={start} className="space-y-3">
                  <Segmented
                    value={who}
                    onChange={setWho}
                    options={[
                      { value: "me", label: "Call as yourself" },
                      { value: "sample", label: "Sample patient" },
                    ]}
                  />
                  {who === "me" ? (
                    <div key="me" className="rise grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <input
                        aria-label="Your name"
                        value={me.name}
                        onChange={(e) => setMe({ ...me, name: e.target.value })}
                        maxLength={60}
                        autoComplete="name"
                        placeholder="Your name"
                        className={inputClass}
                      />
                      <input
                        aria-label="Phone number"
                        value={me.phone}
                        onChange={(e) => setMe({ ...me, phone: e.target.value })}
                        inputMode="tel"
                        autoComplete="tel"
                        placeholder="+91 98765 43210"
                        className={`${inputClass} font-mono text-[14.5px]`}
                      />
                    </div>
                  ) : (
                    <div key="sample" className="rise grid grid-cols-2 gap-2">
                      {(config?.callers ?? []).map((c) => (
                        <button
                          key={c.phone}
                          type="button"
                          onClick={() => setSample(c.phone)}
                          className={`lift flex cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left ${
                            sample === c.phone ? "border-accent bg-accent-soft" : "border-rule bg-card hover:border-rule-2"
                          }`}
                        >
                          <Initials name={c.patient_id ? c.name : "?"} active={sample === c.phone} small />
                          <span className="min-w-0">
                            <span className="block truncate text-[13.5px] font-medium text-ink">{c.name}</span>
                            <span className="block truncate font-mono text-[11px] text-ink-3">{c.phone}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  <button
                    type="submit"
                    disabled={!ready || (who === "me" && !meValid)}
                    className="lift flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-[15px] font-medium text-paper transition-colors hover:bg-[#355b4c] disabled:cursor-not-allowed disabled:bg-rule-2 disabled:text-ink-3"
                  >
                    <PhoneIcon />
                    {phase === "ended" ? "Call again" : `Call ${agentName}`}
                  </button>
                  <p className="text-center text-[12.5px] leading-relaxed text-ink-3">
                    {who === "me"
                      ? "You're added to the mock CRM with one upcoming check-up, in memory only. A made-up number is fine."
                      : "Sample patients each have one upcoming check-up to move or cancel."}{" "}
                    {hosted
                      ? "Demo calls end after 3 minutes, and each visitor gets a few an hour. After a quiet spell, Meera can take 20 seconds to pick up."
                      : "Calls make paid Gemini requests."}
                  </p>
                  {phase === "ended" && roomName && !hosted && (
                    <a href={`#/calls/${roomName}`} className="block text-center text-[14px] font-medium text-accent hover:underline">
                      View this call's trace →
                    </a>
                  )}
                </form>
              )}
              {inCall && (
                <div className="flex justify-center gap-3">
                  <button
                    type="button"
                    onClick={toggleMute}
                    disabled={phase !== "live"}
                    className="lift cursor-pointer rounded-full border border-rule-2 bg-card px-5 py-3 text-[14px] font-medium text-ink disabled:opacity-40"
                  >
                    {muted ? "Unmute" : "Mute"}
                  </button>
                  <button
                    type="button"
                    onClick={hangUp}
                    className="lift flex cursor-pointer items-center gap-2 rounded-full bg-bad px-6 py-3 text-[14px] font-medium text-white"
                  >
                    <PhoneIcon /> Hang up
                  </button>
                </div>
              )}
              {!ready && (
                <div className="mt-3 rounded-lg bg-warn-soft px-4 py-3 text-[13.5px] leading-relaxed text-warn">
                  Set <code className="font-mono">GEMINI_API_KEY</code> in <code className="font-mono">.env</code>, start LiveKit and the
                  agent worker (see the README), then reload.
                </div>
              )}
              {error && <div className="rise mt-3 rounded-lg bg-bad-soft px-4 py-3 text-[14px] text-bad">{error}</div>}
            </div>
          </div>

          {/* What is being said. */}
          <div className="flex min-h-[420px] flex-col lg:h-[640px]">
            <div className="flex items-center justify-between border-b border-rule px-6 py-4">
              <h2 className="text-[13px] font-medium tracking-wide text-ink-2 uppercase">Live transcript</h2>
              {roomName && phase !== "idle" && <span className="font-mono text-[12px] text-ink-3">{roomName}</span>}
            </div>
            <div ref={transcriptRef} className="flex-1 space-y-3 overflow-y-auto px-6 py-5">
              {lines.length === 0 && (
                <div className="mx-auto flex h-full max-w-sm flex-col justify-center">
                  <div className="text-[12px] tracking-wide text-ink-3 uppercase">Things to try saying</div>
                  <ul className="stagger mt-3 space-y-3">
                    {TRY.map((t) => (
                      <li key={t.say} className="border-l-2 border-rule pl-3 transition-colors hover:border-accent">
                        <div className="font-serif text-[17px] leading-snug text-ink">“{t.say}”</div>
                        <div className="text-[13px] text-ink-3">{t.shows}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {lines.map((l) => (
                <div key={l.id} className={`bubble-in flex items-end gap-2 ${l.role === "caller" ? "justify-end" : "justify-start"}`}>
                  {l.role === "agent" && <Initials name={agentName} active small />}
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed transition-opacity duration-300 ${
                      l.role === "caller" ? "rounded-br-md bg-ink text-paper" : "rounded-bl-md border border-rule bg-paper text-ink"
                    } ${l.final ? "" : "opacity-70"}`}
                  >
                    {l.text}
                  </div>
                </div>
              ))}
              {phase === "live" && agentState === "thinking" && (
                <div className="bubble-in flex items-end gap-2">
                  <Initials name={agentName} active small />
                  <div className="flex gap-1 rounded-2xl rounded-bl-md border border-rule bg-paper px-4 py-3.5">
                    {[0, 1, 2].map((i) => (
                      <span key={i} className="think-dot h-1.5 w-1.5 rounded-full bg-ink-3" style={{ animationDelay: `${i * 0.15}s` }} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        <div ref={audioRef} className="hidden" />
      </section>

      <div className="rise mt-6" style={{ ["--i" as string]: 2 }}>
        <FaultPanel
          hosted={hosted}
          value={fault}
          onChoose={(f) => {
            setFault(f);
            // Mid-call on the demo, the agent reads this attribute and breaks its own CRM.
            const room = roomRef.current;
            if (hosted && phase === "live" && room) {
              void room.localParticipant.setAttributes({ "crm.fault": JSON.stringify({ count: 0, probability: 1, path_prefix: "", latency_ms: 2500, ...f }) });
            }
          }}
        />
      </div>

      {events.length > 0 && <LiveTrace events={events} room={roomName} live={phase === "live"} />}
    </>
  );
}

function upsert(lines: Line[], line: Line): Line[] {
  const i = lines.findIndex((l) => l.id === line.id);
  if (i === -1) return [...lines, line];
  const next = lines.slice();
  next[i] = line;
  return next;
}

function Segmented<T extends string>(props: { value: T; onChange: (v: T) => void; disabled?: boolean; options: { value: T; label: string }[] }) {
  const i = Math.max(0, props.options.findIndex((o) => o.value === props.value));
  return (
    <div className="relative grid grid-cols-2 rounded-lg border border-rule bg-paper p-0.5 text-[12.5px] normal-case">
      <span
        aria-hidden
        className="absolute top-0.5 bottom-0.5 left-0.5 w-[calc(50%-2px)] rounded-md bg-ink transition-transform duration-300 ease-[var(--ease-out-soft)]"
        style={{ transform: `translateX(${i * 100}%)` }}
      />
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={props.disabled}
          onClick={() => props.onChange(o.value)}
          className={`relative cursor-pointer rounded-md px-3 py-1 whitespace-nowrap transition-colors duration-300 disabled:cursor-not-allowed ${
            props.value === o.value ? "text-paper" : "text-ink-3 hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Initials({ name, active, small }: { name: string; active?: boolean; small?: boolean }) {
  const letters = name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2);
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full font-serif transition-colors ${small ? "h-7 w-7 text-[12px]" : "h-9 w-9 text-[14px]"} ${
        active ? "bg-accent text-paper" : "bg-rule text-ink-2"
      }`}
    >
      {letters}
    </span>
  );
}

function PhoneIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />
    </svg>
  );
}

const FAULTS: { mode: string; label: string; detail: string; fault: Partial<Fault> }[] = [
  { mode: "none", label: "Healthy", detail: "Every request works.", fault: { mode: "none" } },
  { mode: "slow", label: "Slow", detail: "2.5 s per request: past the 1.5 s pre-call budget.", fault: { mode: "slow", latency_ms: 2500 } },
  { mode: "error_500", label: "One 500", detail: "The next request fails once; the client retries.", fault: { mode: "error_500", count: 1 } },
  { mode: "rate_limit", label: "Rate limited", detail: "429 with Retry-After on the next two requests.", fault: { mode: "rate_limit", count: 2 } },
  { mode: "lost_response", label: "Lost reply", detail: "The next booking commits, but its response never arrives.", fault: { mode: "lost_response", count: 1, path_prefix: "/appointments" } },
  { mode: "bad_data", label: "Bad data", detail: "Slot listings come back malformed.", fault: { mode: "bad_data", path_prefix: "/slots" } },
  { mode: "down", label: "Down", detail: "Every request returns 503.", fault: { mode: "down" } },
];

function FaultPanel({ hosted, value, onChoose }: { hosted: boolean; value: Partial<Fault>; onChoose: (f: Partial<Fault>) => void }) {
  const [current, setCurrent] = useState<{ fault: Fault; remaining: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => api.faults().then(setCurrent).catch(() => undefined);
  useEffect(() => {
    if (hosted) return; // no shared CRM to poll on the demo
    void refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [hosted]);

  async function choose(f: Partial<Fault>) {
    if (hosted) {
      onChoose(f);
      return;
    }
    setBusy(true);
    await api.setFault({ count: 0, probability: 1, path_prefix: "", latency_ms: 2500, ...f }).catch(() => undefined);
    await refresh();
    setBusy(false);
  }

  const active = hosted ? (value.mode ?? "none") : (current?.fault.mode ?? "none");
  const chosen = FAULTS.find((f) => f.mode === active);
  return (
    <section className="rounded-2xl border border-rule bg-card px-6 py-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
        <div className="lg:w-64 lg:shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[13px] font-medium tracking-wide text-ink-2 uppercase">Break the CRM</h2>
            <span className={`h-2 w-2 rounded-full ${active === "none" ? "bg-accent" : "live-dot bg-warn"}`} />
          </div>
          <p className="mt-1 text-[13px] leading-snug text-ink-3">Make the booking system fail mid-call and watch the agent cope.</p>
        </div>
        <div className="flex-1">
          <div className="flex flex-wrap gap-1.5">
            {FAULTS.map((f) => (
              <button
                key={f.mode}
                type="button"
                disabled={busy}
                onClick={() => choose(f.fault)}
                className={`lift cursor-pointer rounded-full border px-3.5 py-1.5 text-[13.5px] transition-colors ${
                  active === f.mode
                    ? f.mode === "none"
                      ? "border-accent bg-accent text-paper"
                      : "border-warn bg-warn text-paper"
                    : "border-rule bg-paper text-ink-2 hover:border-rule-2 hover:text-ink"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <p key={active} className="rise mt-2.5 text-[13.5px] text-ink-2">
            {chosen?.detail}
            {current && current.fault.count > 0 && <span className="text-ink-3"> · {current.remaining} faulted request(s) left, then healthy.</span>}
          </p>
        </div>
      </div>
    </section>
  );
}

/** The call's trace as the agent logs it, streamed over the room: CRM attempts, tools,
 * guards, transfers. On the demo, where calls are not stored, it can be saved as JSON. */
function LiveTrace({ events, room, live }: { events: CallEvent[]; room: string | null; live: boolean }) {
  const shown = events.filter((e) => !["trace", "agent_say"].includes(e.kind));
  function download() {
    const blob = new Blob([JSON.stringify({ call_id: room, events }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${room ?? "call"}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  return (
    <section className="rise mt-6 rounded-2xl border border-rule bg-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-6 py-4">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-medium tracking-wide text-ink-2 uppercase">This call's trace</h2>
          {live && <span className="live-dot h-2 w-2 rounded-full bg-bad" />}
        </div>
        <button
          type="button"
          onClick={download}
          className="lift cursor-pointer rounded-lg border border-rule-2 bg-card px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-paper"
        >
          Download JSON
        </button>
      </header>
      <ol className="space-y-3 px-6 py-5">
        {shown.map((e) => (
          <li key={e.seq} className="bubble-in grid grid-cols-[52px_minmax(0,1fr)] gap-3">
            <div className="pt-0.5 text-right font-mono text-[12px] text-ink-3 tabular-nums">+{e.at.toFixed(1)}s</div>
            <div className="min-w-0">
              <EventRow event={e} />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
