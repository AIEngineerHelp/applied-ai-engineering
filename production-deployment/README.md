# Production & Deployment

Take AI applications from prototype to production. Discuss deployment, inference, observability, latency, cost optimization, and operational challenges.

[Community category](https://aiengineer.help/c/production-deployment/9) · [Repository home](../README.md)

## What belongs here

Use this category for serving, deployment, observability, caching, operational reliability, and cost or latency experiments. Architecture discussions without an operational focus belong in System Design & Architecture.

## Projects and resources

| Project | What it teaches | Status |
| --- | --- | --- |
| [Prompt caching: what breaks it, what it saves](prompt-caching/README.md) | How prefix caching works on Claude, Gemini and OpenAI, eight layout mistakes that silently disable it, an in-browser playground that finds them and reorders the prompt, and a live Gemini experiment: implicit caching 0 hits in 97 requests, explicit caching 12 of 12 and 84% cheaper per request | Runnable Node.js example; article and playground run locally with no API key; live results included |
| [Incident response agent](../agents/incident-response-agent/README.md#architecture) | Running an agent behind an API and queue workers: persistence, crash recovery, auth, audit log, metrics, Docker Compose and Helm | Part of the [incident response agent](../agents/incident-response-agent/README.md) (primary category: Agents); runs locally, not yet deployed to a cluster |

## Adding a contribution

Create a descriptive kebab-case project directory with its own README. Document its purpose, dependencies, setup, verification, and relevant sources. Add it to this index and link its community discussion when one exists. Keep dependencies local to the project. See the [repository guide](../AGENTS.md) for the full conventions.
