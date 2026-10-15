// The groundedness judge's prompt.

export const JUDGE_SYSTEM =
  "You check claims against evidence. For each numbered claim, decide if the evidence text supports it: supported (fully), partial (some of it, or a number differs), unsupported (not in the evidence). Judge only from the evidence given.";
