# Applied AI Engineering

Learn, build, and share AI engineering with the [AI Engineer Help community](https://aiengineer.help/).

This repository brings together independent examples, experiments, and learning resources. Each project lives in one primary category and owns its dependencies, documentation, and verification steps.

## Explore by category

The directories follow the community’s learning categories; `agents/` is the shortened name for Agents & Workflows. Each category README explains its scope and indexes its projects.

| Category | Community |
| --- | --- |
| [System Design & Architecture](system-design-architecture/README.md) | [Discuss](https://aiengineer.help/c/system-design-architecture/5) |
| [RAG & Retrieval](rag-retrieval/README.md) | [Discuss](https://aiengineer.help/c/rag-retrieval/6) |
| [Agents](agents/README.md) | [Discuss](https://aiengineer.help/c/agents-workflows/7) |
| [Evaluations & Reliability](evaluations-reliability/README.md) | [Discuss](https://aiengineer.help/c/evaluations-reliability/8) |
| [Production & Deployment](production-deployment/README.md) | [Discuss](https://aiengineer.help/c/production-deployment/9) |
| [Careers & Learning](careers-learning/README.md) | [Discuss](https://aiengineer.help/c/careers-learning/10) |
| [Product Breakdowns](showcase/README.md) | [Discuss](https://aiengineer.help/c/showcase/11) |
| [Research & Papers](research-papers/README.md) | [Discuss](https://aiengineer.help/c/research-papers/12) |
| [Models & Fine-Tuning](models-fine-tuning/README.md) | [Discuss](https://aiengineer.help/c/models-fine-tuning/13) |

General and Site Feedback remain community discussion spaces rather than code directories. Product Breakdowns maps to `showcase/`, matching its community URL slug.

## Projects

[Building a Multi-Agent Travel Planner with Gemini and TypeSafe AI](agents/travel-planner-gemini-typesafe/README.md)

Travel Lab compares Gemini-only coordination with Jev agent and tool selection, using the same Gemini workers and limits. The TypeScript website researches live places with Gemini Google Search grounding, shows decision traces and evidence, and saves each run. Synthetic catalogs remain for offline tests and evaluation. Local web-search smoke comparisons completed for both teams; controlled routing and whole-agent benchmark results are included. Public-deployment review remains outstanding.

[Incident response agent](agents/incident-response-agent/README.md) investigates operational incidents from logs: a LangGraph agent plans, queries 14 public Loghub datasets, cites evidence, proposes fixes behind guardrails and human approval, and writes a root-cause report. A Next.js dashboard shows its live activity, the logs, a knowledge graph built from them, and an evaluation against expert labels (27 of 28 BGL incidents right, 28 of 28 on unseen cases). It runs locally with Docker; the README describes how it works and ways to extend it.

[Dino Runner × Jev](showcase/dino-runner-jev/README.md) ([live demo](https://dino-runner-jev.vercel.app)) is an original endless-runner game in the style of Chrome's offline dinosaur. Code runs the physics and timing, and Jev chooses one move per obstacle. Real-time and paused modes show how decision latency, not just correctness, decides the outcome, and a live telemetry panel plots every call's round trip against the time the game allowed. Tests and the benchmark dry run need no API key.

[Biomedical hybrid search](rag-retrieval/biomedical-search/README.md) compares BM25, dense search, and hybrid retrieval over biomedical passages, with optional Gemini or TypeSafe Jev reranking, with evidence inspection, Gemini-generated answers, and a fixed 100-question evaluation set. Included benchmark results are explicitly labeled as a historical local-model baseline.

[LLM-as-a-Judge: Measuring agreement, bias, and reliability](evaluations-reliability/llm-judge-reliability/README.md) ([read the report](https://llm-judge-reliability.vercel.app)) tests Gemini and Jev judges on AI-written synthetic mistakes and on 120 real answers from RAGTruth, whose errors were marked by people. Judges score 98–99% on the easy set but 53–68% on real answers, and a review of the disagreements shows the labels are often the ones at fault. A local dashboard shows every answer next to every verdict.

[Prompt caching: what breaks it, what it saves, and what we measured](production-deployment/prompt-caching/README.md) explains how Claude, Gemini and OpenAI reuse a prompt's prefix. It shows eight layout mistakes, such as a timestamp at the top, that switch caching off without an error. An interactive playground highlights those mistakes in your own prompt, estimates the cost per 1,000 requests, and reorders the prompt in one click. A live experiment on Gemini 3.8 Flash found that a misplaced timestamp cut the reusable prefix from 99.7% to 14.4%. Implicit caching hit 0 times in 97 requests, while explicit caching hit 12 of 12 and cut the cost per request by 84%.

## Contributing

1. Choose the category matching the main lesson of your contribution.
2. Create `<category>/<project-name>/` and document how to set up, run, and verify it.
3. Add a link to the category index. Cross-link from other categories when useful instead of copying code.
4. Link related community discussions from the project README and share the code link in the discussion.

Use community tags for providers, frameworks, languages, and topics that span categories. Keep project tests and deployment files with their project.

Read [CONTRIBUTING.md](CONTRIBUTING.md) to add a project and [AGENTS.md](AGENTS.md) for repository conventions. [CLAUDE.md](CLAUDE.md) imports the same instructions for Claude Code.

There is no shared installation or test command yet. No repository license has been selected.
