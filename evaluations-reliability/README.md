# Evaluations & Reliability

Measure and improve the quality of AI systems. Discuss evaluation datasets, testing strategies, hallucinations, guardrails, and failure analysis.

[Community category](https://aiengineer.help/c/evaluations-reliability/8) · [Repository home](../README.md)

## What belongs here

Use this category when the main contribution is an evaluation method, test suite, guardrail experiment, or failure analysis. Tests for an individual project stay with that project.

## Projects and resources

| Project | What it teaches | Status |
| --- | --- | --- |
| [LLM-as-a-Judge: agreement, bias, and reliability](llm-judge-reliability/README.md) | Testing Gemini and Jev judges on synthetic mistakes and on 120 real RAGTruth answers labelled by people: agreement, who is right when judge and label disagree, blind spots, confident mistakes, length bias and consistency | Runnable Python example; [report and dataset explorer online](https://llm-judge-reliability.vercel.app); live results included |
| [Guardrails for AI agents: what each layer actually stops](agent-guardrails/README.md) | Guardrails taught through an illustrated story, then measured on a refund-support agent: rules vs Gemini vs Jev classifiers on attacks and look-alike requests, and which layer stops each harmful action with a hijacked model and with real Gemini | Runnable Python example; [illustrated story and data explorer online](https://agent-guardrails-beta.vercel.app); live results included |
| [Incident response agent evals](../agents/incident-response-agent/docs/evals.md) | Scoring an agent's root-cause answers against an answer key with deterministic marking, hold-out cases and a lazy-guess baseline | Part of the [incident response agent](../agents/incident-response-agent/README.md) (primary category: Agents) |

## Adding a contribution

Create a descriptive kebab-case project directory with its own README. Document its purpose, dependencies, setup, verification, and relevant sources. Add it to this index and link its community discussion when one exists. Keep dependencies local to the project. See the [repository guide](../AGENTS.md) for the full conventions.
