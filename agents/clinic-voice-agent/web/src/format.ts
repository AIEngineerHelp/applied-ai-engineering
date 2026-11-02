// Formatting helpers shared by the pages. Kept pure so they can be unit-tested.

export function ms(value: number | null | undefined): string {
  if (value == null) return "–";
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 2)} s`;
  return `${Math.round(value)} ms`;
}

export function usd(value: number | null | undefined, digits = 4): string {
  if (value == null) return "–";
  if (value === 0) return "$0";
  return `$${value.toFixed(digits)}`;
}

export function duration(seconds: number | null | undefined): string {
  if (seconds == null) return "–";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`;
}

export function when(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const STATUS_LABEL: Record<string, string> = {
  resolved: "Resolved",
  transferred: "Transferred",
  caller_hung_up: "Caller hung up",
  error: "Error",
  timed_out: "Timed out",
  in_progress: "In progress",
};

export function statusLabel(status: string | null): string {
  return STATUS_LABEL[status ?? "in_progress"] ?? status ?? "In progress";
}

export function pipelineLabel(pipeline: string): string {
  if (pipeline === "realtime") return "Realtime (Gemini Live)";
  if (pipeline === "cascade") return "Cascade (STT → LLM → TTS)";
  if (pipeline === "scripted") return "Simulation · scripted model";
  if (pipeline.startsWith("text:")) return `Simulation · ${pipeline.slice(5)}`;
  return pipeline;
}
