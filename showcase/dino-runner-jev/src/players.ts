import type { Action, Kind } from "./game.js";

// Jev reads meaning better than numbers (docs: model-jaggedness/jev-1.13), so
// code turns each obstacle into words. Positions are described relative to the
// dino; distances, speeds, and timing never reach the model.
const STATES: Record<Kind, { type: string; size: string; position: string }> = {
  "small-cactus": { type: "cactus", size: "small", position: "standing on the ground" },
  "large-cactus": { type: "cactus", size: "tall", position: "standing on the ground" },
  "cactus-cluster": { type: "cactus", size: "wide cluster", position: "standing on the ground" },
  "low-bird": { type: "bird", size: "medium", position: "flying low, near the dino's feet" },
  "mid-bird": { type: "bird", size: "medium", position: "flying at the dino's head height" },
  "high-bird": { type: "bird", size: "medium", position: "flying above the dino's head" },
};

export function obstacleState(kind: Kind) {
  return { obstacle: { ...STATES[kind] } };
}

export const INSTRUCTION =
  "Choose the dino's move for the obstacle in `obstacle` so the dino gets past it without touching it. The game handles timing; choose only the move.";

// Each option describes what the move physically does, not which obstacle it is for.
export const CRITERIA: Record<Action, string> = {
  jump: "Jump high into the air. The dino rises well above its own height, clearing anything on the ground and birds at foot or head height, but it rises into birds flying above its head.",
  duck: "Crouch while running. The dino becomes about half as tall and passes under birds at head height or higher, but it still runs into anything on the ground or at foot level.",
  run: "Keep running upright without changing posture. Safe only when the obstacle is entirely above the dino's head.",
};

/** The baseline player: a lookup table any programmer would write. */
export function ruleAction(kind: Kind): Action {
  if (kind === "mid-bird") return "duck";
  if (kind === "high-bird") return "run";
  return "jump";
}
