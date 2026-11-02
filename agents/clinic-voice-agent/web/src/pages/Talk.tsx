import type { Participant, RemoteTrack, Room } from "livekit-client";
import { useEffect, useRef, useState } from "react";
import { api, type Config, type Fault } from "../api";
import { Badge, Button, Card, PageHeader } from "../components/ui";

type Line = { id: string; role: "caller" | "agent"; text: string; final: boolean };
type Phase = "idle" | "connecting" | "live" | "ended";

const AGENT_STATE_LABEL: Record<string, string> = {
  initializing: "Joining…",
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

export function TalkPage({ config }: { config: Config | null }) {
  const [caller, setCaller] = useState<string>("+15550142201");
  const [pipeline, setPipeline] = useState<"realtime" | "cascade">("realtime");
  const [phase, setPhase] = useState<Phase>("idle");
  const [agentState, setAgentState] = useState("initializing");
  const [lines, setLines] = useState<Line[]>([]);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roomName, setRoomName] = useState<string | null>(null);
  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (config) setPipeline(config.default_pipeline);
  }, [config]);

  useEffect(() => () => void roomRef.current?.disconnect(), []);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  async function start() {
    setError(null);
    setLines([]);
    setPhase("connecting");
    setAgentState("initializing");
    try {
      const { url, token, room: name } = await api.session(pipeline, caller || null);
      // Loaded on demand: the WebRTC client is most of the bundle and only this button needs it.
      const { Room, RoomEvent, Track } = await import("livekit-client");
      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;
      setRoomName(name);

      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) audioRef.current?.appendChild(track.attach());
      });
      room.on(RoomEvent.ParticipantAttributesChanged, (changed: Record<string, string>, p: Participant) => {
        if (!p.isLocal && changed["lk.agent.state"]) setAgentState(changed["lk.agent.state"]);
      });
      room.on(RoomEvent.ParticipantDisconnected, (p: Participant) => {
        if (!p.isLocal) void room.disconnect();
      });
      room.on(RoomEvent.Disconnected, () => setPhase("ended"));
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
      setPhase("live");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
  const cascadeOk = config?.livekit_cloud ?? false;
  const inCall = phase === "connecting" || phase === "live";

  return (
    <>
      <PageHeader
        title="Talk to the agent"
        lede={
          <>
            Call {config?.clinic.agent_name ?? "Robin"}, the front desk of a fictional clinic, from your browser. Pick who you are
            calling as: the agent looks you up before it answers. Then break the CRM mid-call and see how the agent copes.
          </>
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <Card title="1 · Who is calling">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(config?.callers ?? []).map((c) => (
                <label
                  key={c.phone}
                  className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 transition-colors ${
                    caller === c.phone ? "border-accent bg-accent-soft" : "border-rule hover:border-rule-2"
                  } ${inCall ? "pointer-events-none opacity-60" : ""}`}
                >
                  <span>
                    <span className="block text-[14px] font-medium text-ink">{c.name}</span>
                    <span className="font-mono text-[12px] text-ink-3">{c.phone}</span>
                  </span>
                  <input type="radio" name="caller" className="accent-[var(--color-accent)]" checked={caller === c.phone} onChange={() => setCaller(c.phone)} />
                </label>
              ))}
            </div>
          </Card>

          <Card title="2 · Which pipeline">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <PipelineOption
                active={pipeline === "realtime"}
                disabled={inCall}
                onSelect={() => setPipeline("realtime")}
                title="Realtime"
                detail={config ? `${config.models.realtime.llm} hears and speaks audio in one model.` : ""}
              />
              <PipelineOption
                active={pipeline === "cascade"}
                disabled={inCall || !cascadeOk}
                onSelect={() => setPipeline("cascade")}
                title="Cascade"
                detail={
                  config
                    ? `${config.models.cascade.stt} → ${config.models.cascade.llm} → ${config.models.cascade.tts}.${
                        cascadeOk ? "" : " Needs a LiveKit Cloud project for STT."
                      }`
                    : ""
                }
              />
            </div>
          </Card>

          <Card title="3 · Call" aside={roomName && phase !== "idle" ? <span className="font-mono">{roomName}</span> : null}>
            {!ready && (
              <div className="mb-4 rounded-lg bg-warn-soft px-4 py-3 text-[14px] leading-relaxed text-warn">
                Set <code className="font-mono">GEMINI_API_KEY</code> in <code className="font-mono">.env</code>, start LiveKit and the
                agent worker (see the README), then reload. Every call makes paid Gemini requests. The Simulation tab works without a
                key.
              </div>
            )}
            <div className="flex flex-col items-center gap-5 py-4 sm:flex-row sm:items-center">
              <AgentOrb phase={phase} state={agentState} />
              <div className="flex-1 text-center sm:text-left">
                <div className="font-serif text-[24px] text-ink">
                  {phase === "idle" && "Ready when you are"}
                  {phase === "connecting" && "Connecting…"}
                  {phase === "live" && (AGENT_STATE_LABEL[agentState] ?? agentState)}
                  {phase === "ended" && "Call ended"}
                </div>
                <div className="mt-1 text-[14px] text-ink-3">
                  {phase === "live" ? "Speak normally. You can interrupt." : phase === "ended" ? "The trace is in the call log." : "Your browser will ask for the microphone."}
                </div>
              </div>
              <div className="flex gap-2">
                {!inCall && (
                  <Button onClick={start} disabled={!ready}>
                    {phase === "ended" ? "Call again" : "Start call"}
                  </Button>
                )}
                {phase === "live" && (
                  <>
                    <Button variant="quiet" onClick={toggleMute}>
                      {muted ? "Unmute" : "Mute"}
                    </Button>
                    <Button variant="danger" onClick={hangUp}>
                      Hang up
                    </Button>
                  </>
                )}
                {phase === "ended" && roomName && (
                  <a href={`#/calls/${roomName}`} className="inline-flex items-center rounded-lg border border-rule-2 bg-card px-4 py-2 text-[14px] font-medium text-ink hover:bg-paper">
                    View trace
                  </a>
                )}
              </div>
            </div>
            {error && <div className="mt-2 rounded-lg bg-bad-soft px-4 py-3 text-[14px] text-bad">{error}</div>}
            <div ref={transcriptRef} className="mt-4 max-h-[340px] min-h-[120px] space-y-3 overflow-y-auto border-t border-rule pt-4">
              {lines.length === 0 && <div className="py-6 text-center text-[14px] text-ink-3">The live transcript appears here.</div>}
              {lines.map((l) => (
                <div key={l.id} className={`flex ${l.role === "caller" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed ${
                      l.role === "caller" ? "bg-ink text-paper" : "border border-rule bg-paper text-ink"
                    } ${l.final ? "" : "opacity-70"}`}
                  >
                    {l.text}
                  </div>
                </div>
              ))}
            </div>
            <div ref={audioRef} className="hidden" />
          </Card>
        </div>

        <div className="space-y-6">
          <FaultPanel />
          <Card title="Things to say">
            <ul className="space-y-3">
              {TRY.map((t) => (
                <li key={t.say}>
                  <div className="font-serif text-[16px] leading-snug text-ink">“{t.say}”</div>
                  <div className="text-[13px] text-ink-3">{t.shows}</div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
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

function PipelineOption(props: { active: boolean; disabled: boolean; onSelect: () => void; title: string; detail: string }) {
  return (
    <button
      type="button"
      onClick={props.onSelect}
      disabled={props.disabled && !props.active}
      className={`cursor-pointer rounded-lg border px-3.5 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        props.active ? "border-accent bg-accent-soft" : "border-rule hover:border-rule-2"
      }`}
    >
      <div className="text-[14px] font-medium text-ink">{props.title}</div>
      <div className="mt-0.5 text-[13px] leading-snug break-words text-ink-3">{props.detail}</div>
    </button>
  );
}

function AgentOrb({ phase, state }: { phase: Phase; state: string }) {
  const speaking = phase === "live" && state === "speaking";
  const thinking = phase === "live" && state === "thinking";
  return (
    <div className="relative grid h-20 w-20 shrink-0 place-items-center" aria-hidden>
      {speaking && <span className="pulse-ring absolute inset-0 rounded-full bg-accent" />}
      <span
        className={`relative grid h-16 w-16 place-items-center rounded-full font-serif text-[26px] transition-colors duration-300 ${
          phase === "live" ? "bg-accent text-paper" : "bg-rule text-ink-3"
        } ${thinking ? "opacity-70" : ""}`}
      >
        R
      </span>
    </div>
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

function FaultPanel() {
  const [current, setCurrent] = useState<{ fault: Fault; remaining: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => api.faults().then(setCurrent).catch(() => undefined);
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, []);

  async function choose(f: Partial<Fault>) {
    setBusy(true);
    await api.setFault({ count: 0, probability: 1, path_prefix: "", latency_ms: 2500, ...f }).catch(() => undefined);
    await refresh();
    setBusy(false);
  }

  const active = current?.fault.mode ?? "none";
  return (
    <Card title="Break the CRM" aside={active !== "none" ? <Badge tone="warn">{active}</Badge> : <Badge tone="good">healthy</Badge>}>
      <p className="mb-3 text-[14px] leading-relaxed text-ink-2">
        The agent books through a mock CRM. Make it fail mid-call and watch how the agent and the trace respond.
      </p>
      <div className="space-y-1.5">
        {FAULTS.map((f) => (
          <button
            key={f.mode}
            type="button"
            disabled={busy}
            onClick={() => choose(f.fault)}
            className={`w-full cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors ${
              active === f.mode ? "border-accent bg-accent-soft" : "border-rule hover:border-rule-2"
            }`}
          >
            <div className="text-[14px] font-medium text-ink">{f.label}</div>
            <div className="text-[12.5px] leading-snug text-ink-3">{f.detail}</div>
          </button>
        ))}
      </div>
      {current && current.fault.count > 0 && (
        <div className="mt-3 text-[13px] text-ink-3">{current.remaining} faulted request(s) left, then healthy.</div>
      )}
    </Card>
  );
}
