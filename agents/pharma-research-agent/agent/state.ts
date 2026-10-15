// The research graph's state. Parallel researchers each add one finding; the
// reducer collects them.

import { Annotation } from "@langchain/langgraph";
import type { EvalResult, Finding, Plan, Report, Screen, Subtask } from "./types.ts";

export const RunStateAnnotation = Annotation.Root({
  reportId: Annotation<string>(),
  /** The input screen's verdict; a refused question ends the run here. */
  screen: Annotation<Screen | undefined>(),
  /** Set only on a researcher's input, by the Send that started it. */
  task: Annotation<Subtask | undefined>(),
  plan: Annotation<Plan | undefined>(),
  findings: Annotation<Finding[]>({ reducer: (all, more) => all.concat(more), default: () => [] }),
  report: Annotation<Report | undefined>(),
  evals: Annotation<EvalResult[] | undefined>(),
});

export type RunState = typeof RunStateAnnotation.State;
