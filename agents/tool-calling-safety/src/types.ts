// Shared shapes for tools, example calls and execution traces.

// One line in an execution trace. "bad" marks the moment harm happens,
// "stop" a safeguard refusing the call, "ask" a pause for a person.
export type StepKind = "info" | "ok" | "bad" | "stop" | "ask";

export interface Step {
  kind: StepKind;
  label: string;
  detail?: string;
  code?: string;
}

export type Outcome = "done" | "harm" | "blocked" | "ask";

export interface Run {
  steps: Step[];
  outcome: Outcome;
  // Plain-language verdict shown at the bottom of the column.
  verdict: string;
  // What goes back to the model as the tool result.
  result: string;
}

export interface ExampleCall {
  id: string;
  label: string;
  // true for ordinary use; the safe implementation must still work for these.
  benign: boolean;
  args: Record<string, string>;
  // Where the argument came from, in plain words: the user, or text the
  // agent read (an indirect prompt injection).
  source: string;
  // One sentence on what this example teaches.
  lesson: string;
}

export interface JsonSchemaProp {
  type: "string";
  description: string;
  maxLength?: number;
  pattern?: string;
  enum?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, JsonSchemaProp>;
    required: string[];
  };
}

export interface Tool {
  id: string;
  kind: string;
  headline: string;
  lede: string;
  definition: ToolDefinition;
  // The permission rule the safe side applies before running anything.
  permission: string;
  naiveCode: string;
  safeCode: string;
  // The fixes, one short line each, shown under the safe column.
  fixes: string[];
  // The risk in OWASP's vocabulary and a real incident, when one fits.
  risk: { name: string; url: string };
  incident?: { text: string; url: string };
  examples: ExampleCall[];
  naive(args: Record<string, string>): Run;
  safe(args: Record<string, string>): Run;
}
