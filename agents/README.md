# Agents

Design agents that use tools, manage memory, and coordinate tasks. Explore MCP, orchestration, multi-agent systems, and automated workflows.

[Community category](https://aiengineer.help/c/agents-workflows/7) · [Repository home](../README.md)

## What belongs here

Use this category for tool use, agent coordination, memory, context management, MCP, and executable workflows. Projects can include their own evaluation and deployment files without being split across categories.

## Projects and resources

| Project | What it explores | Status |
| --- | --- | --- |
| [Travel planner with Gemini and TypeSafe](travel-planner-gemini-typesafe/README.md) | Compare Gemini-only coordination with Jev agent and tool selection using live web research | Runnable TypeScript prototype with controlled benchmark results |
| [Incident response agent](incident-response-agent/README.md) | A LangGraph agent that investigates incidents from logs: planning, tool use, guardrails, human approval, memory and a knowledge graph, with a dashboard | Runnable Python/Next.js prototype, evaluated on Loghub BGL; README lists ways to extend it |
| [Tools, tool calling and unsafe execution](tool-calling-safety/README.md) | How tool calling works, and how an unsafe implementation of one tool turns a harmless model output into a real attack: path traversal, SSRF, command injection, code eval and the confused deputy, each shown next to its fix | Runnable TypeScript web app; all simulated, no API keys |
| [Anatomy of a harness](harness-anatomy/README.md) | The parts around a model that make it an agent — context management, the execution environment, delegation and steering — drawn as an animated factory you can run and take apart, with what each missing part costs | Runnable TypeScript web app; scripted run, no API keys; [live](https://harness-anatomy.vercel.app) |
| [Pharma research agent](pharma-research-agent/README.md) | A production-shaped research workspace: an orchestrator with a skills layer, parallel sub-agents over PubMed, ClinicalTrials.gov, openFDA and the web, a virtual file system, a synthesis agent, evals and traces; durable runs, Postgres, live streaming, PDF/DOCX export and share links | Runnable Next.js 16 app; offline mode needs no key |
| [Wiki memory for agents](wiki-memory/README.md) | An agent that keeps an interlinked markdown wiki instead of re-reading raw chunks: ingest, query and lint, superseding outdated claims, and a comparison with chunk RAG on the same sources | Article with a runnable TypeScript web app; scripted pages, computed diffs, lint and retrieval, no API keys; [live](https://wiki-memory.vercel.app) |

## Adding a contribution

Create a descriptive kebab-case project directory with its own README. Document its purpose, dependencies, setup, verification, and relevant sources. Add it to this index and link its community discussion when one exists. Keep dependencies local to the project. See the [repository guide](../AGENTS.md) for the full conventions.
