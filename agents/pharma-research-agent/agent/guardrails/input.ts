// The input screen: what happens to a question before any research runs.
//   1. Deterministic: personal data is already redacted by the API route
//      (before it reaches the database); a pattern check catches direct
//      prompt injection without a model call.
//   2. One fast model call classifies the question against the risk catalogue.
// Refused questions end the run; personal advice is redirected to its general form.

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { callModel } from "../model.ts";
import { screenSystem } from "../prompts/guards.ts";
import type { Screen, Usage } from "../types.ts";
import { findInjection } from "./injection.ts";
import { RISKS } from "./risks.ts";

const VERDICTS: Screen["verdict"][] = ["research", "personal_advice", "off_topic", "harmful", "self_harm", "prompt_injection"];

const SCREEN_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: VERDICTS },
    risks: { type: "array", items: { type: "string", enum: RISKS.map((r) => r.id) }, description: "Risk ids the question touches; empty for research." },
    general_question: { type: "string", description: "For personal_advice: the question asked about the population, with personal details removed. Otherwise empty." },
    reason: { type: "string", description: "Why, in one sentence." },
  },
  required: ["verdict", "risks", "general_question", "reason"],
};

/** What the user sees for each refused or redirected verdict. */
export const MESSAGES: Record<Exclude<Screen["verdict"], "research">, string> = {
  personal_advice:
    "I can't advise on your own treatment or dose; that needs a clinician who knows your health history. Below is what the published evidence says in general, which you can take to your doctor or pharmacist.",
  off_topic: "I research medicines and clinical evidence: studies, trials, FDA labels and safety reports. Ask a question about a drug, a treatment or a safety signal.",
  harmful: "I can't help with that request.",
  self_harm:
    "I can't help with that. If you're thinking about harming yourself, please contact your local emergency number or a crisis line now; in the US you can call or text 988.",
  prompt_injection: "This message looks like an attempt to change how the assistant works, so it wasn't run. Ask a research question instead.",
};

export interface ScreenResult {
  screen: Screen;
  risks: string[];
  reason: string;
  /** Which layer decided: the pattern check or the model. */
  by: "pattern" | "model";
  usage?: Usage;
}

export async function screenQuestion(model: BaseChatModel, question: string, context?: string): Promise<ScreenResult> {
  const injected = findInjection(question);
  if (injected) {
    return { screen: { verdict: "prompt_injection", question, message: MESSAGES.prompt_injection }, risks: ["prompt-injection"], reason: `Matched "${injected}".`, by: "pattern" };
  }
  const user = context ? `${context}\n\nQuestion to screen: ${question}` : `Question to screen: ${question}`;
  const r = await callModel(model, [new SystemMessage(screenSystem()), new HumanMessage(user)], { schema: SCREEN_SCHEMA });
  const raw = r.json as { verdict?: string; risks?: string[]; general_question?: string; reason?: string };
  const verdict = (VERDICTS.includes(raw.verdict as Screen["verdict"]) ? raw.verdict : "research") as Screen["verdict"];
  const general = raw.general_question?.trim();
  const screen: Screen =
    verdict === "research"
      ? { verdict, question }
      : verdict === "personal_advice" && general
        ? { verdict, question: general, message: MESSAGES.personal_advice, redirected: true }
        : verdict === "personal_advice"
          ? // Redirect needs a general question; without one, refuse rather than research the personal one.
            { verdict, question, message: MESSAGES.personal_advice.replace(" Below is what the published evidence says in general, which you can take to your doctor or pharmacist.", " Try asking about the evidence for a group of patients instead.") }
          : { verdict, question, message: MESSAGES[verdict] };
  return { screen, risks: (raw.risks ?? []).filter((id) => RISKS.some((x) => x.id === id)), reason: raw.reason ?? "", by: "model", usage: r.usage };
}

/** Whether the run stops at the screen: everything but research and a redirected personal question. */
export const isBlocked = (s: Screen) => s.verdict !== "research" && !s.redirected;
