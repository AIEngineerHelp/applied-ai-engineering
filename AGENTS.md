# AI Engineer Help — repository guide for coding agents

## Purpose

This repository is the shared code and learning library for the AI Engineer Help community. We learn, build, and share knowledge about AI, with practical examples that others can run, understand, improve, and discuss.

- Community: https://aiengineer.help/
- Community categories: https://aiengineer.help/categories
- GitHub organization: https://github.com/AIEngineerHelp
- Repository: https://github.com/AIEngineerHelp/applied-ai-engineering

GitHub holds the code, documentation, and contribution history. The community hosts explanations, questions, feedback, and discussions. Connect the two with links whenever a related discussion exists.

This is a collection of independent projects and resources, rather than one application. Languages, frameworks, and model providers may differ between examples. Favor useful, understandable contributions over volume or unnecessary complexity.

## Current state

The repository contains a root README, nine learning-category directories with README indexes, a contribution guide, and a root `.gitignore`. No runnable examples, project license, or CI have been established yet. There is no repository-wide install, build, lint, or test command. Inspect actual files before assuming a toolchain or command exists.

Update this section as the repository grows. The category directories below exist; their README indexes distinguish planned projects from runnable examples.

## Category structure

Use one top-level directory per learning category, with lowercase kebab-case names. Most names match community slugs; `agents/` is the intentionally shortened repository name for Agents & Workflows. Categories were checked on 2026-09-18.

| Directory | Community category | Typical content |
| --- | --- | --- |
| `system-design-architecture/` | System Design & Architecture | Architectures, design patterns, engineering trade-offs |
| `rag-retrieval/` | RAG & Retrieval | Embeddings, chunking, search, reranking, knowledge graphs |
| `agents/` | Agents & Workflows | Tool use, memory, MCP, orchestration, agent workflows |
| `evaluations-reliability/` | Evaluations & Reliability | Evaluation datasets, testing, guardrails, failure analysis |
| `production-deployment/` | Production & Deployment | Serving, deployment, observability, latency, cost |
| `careers-learning/` | Careers & Learning | Learning exercises, roadmaps, educational resources |
| `showcase/` | Product Breakdowns | Demos, projects, experiments, technical walkthroughs |
| `research-papers/` | Research & Papers | Paper notes, reproductions, practical experiments |
| `models-fine-tuning/` | Models & Fine-Tuning | Model selection, adaptation, distillation, quantization, multimodal examples |

Product Breakdowns currently uses the community slug `showcase`; keep that mapping explicit. General and Site Feedback are community administration/discussion categories and do not need code directories by default.

- Maintain the existing category directories and their scope/index READMEs. Add new categories only when needed; avoid empty project scaffolding.
- Place each example in `<category>/<example-name>/`, such as `rag-retrieval/basic-document-search/`.
- Choose one primary category for an example that spans several topics. Cross-link it from other category indexes instead of duplicating code.
- When adding a new subject, check existing categories first. Explain a new category in the contribution; do not silently rename or move existing categories.
- Give each populated category a `README.md` indexing its examples and relevant community category.
- Keep the root `README.md` index current when it exists; create a minimal root index with the first content contribution.

## Independent examples

Each runnable example owns its dependencies, configuration, setup instructions, and verification steps. Use the language's normal dependency manifest and an appropriate lockfile where supported. Do not impose a shared root toolchain unless multiple examples have a demonstrated need for it.

A typical example may contain:

```text
<category>/<example-name>/
  README.md
  <dependency manifest and applicable lockfile>
  .env.example       # only when configuration is needed
  <source files or notebooks>
  <tests or evaluation fixtures, when useful>
```

Every example README should explain:

1. What the example teaches, its use case, and important limitations.
2. Required runtime versions, dependencies, accounts, models, and hardware.
3. Exact setup and run commands, including the directory to run them from.
4. Required configuration, using placeholder values rather than credentials.
5. Expected output and how to verify success; note that model responses can vary.
6. API charges, downloads, resource requirements, and cleanup where applicable.
7. Sources and attribution, plus a related community topic link if one exists.

Documentation-only resources can use a simpler structure. Notebooks should explain execution order and must not retain secrets, private data, or unnecessarily large outputs.

## Code and data expectations

- Follow the conventions of the example being changed. Prefer clear names, small modules, and comments that explain meaningful decisions.
- Keep examples focused on their teaching goal. Add abstractions and shared utilities only when they improve understanding or solve demonstrated duplication.
- Make model/provider settings explicit and configurable where practical. Document the versions or model identifiers used to verify an example.
- Check current official documentation when introducing or changing SDK calls; do not assume APIs or model availability from memory.
- Handle likely failures such as missing configuration, rate limits, timeouts, and unavailable models. Bound retries, agent loops, and concurrency.
- Keep credentials in environment variables or an appropriate secret store. Commit only placeholders in `.env.example`; exclude real `.env` files, environments, dependency directories, and generated artifacts from Git.
- Use small synthetic or redistributable sample data. Document dataset provenance, licensing, and download instructions. Keep model weights and large datasets outside Git.
- Preserve attribution and respect source licenses. No project license has been selected yet; do not invent one or claim redistribution rights without checking.
- Treat educational demos honestly: distinguish measured results from expectations and document limitations before describing an example as production-ready.

## Workflow and verification

1. Read the relevant README files, dependency manifests, and any instructions inside the affected directory. More specific directory instructions refine this guide for that subtree.
2. Inspect the working tree and preserve unrelated contributor changes. Limit edits to the requested contribution.
3. Implement the example or fix, including documentation and relevant indexes.
4. Run the affected example's documented checks. Add meaningful tests for deterministic logic, regressions, or evaluation behavior where appropriate; documentation-only edits need link/path and command consistency checks.
5. Prefer mocks, fixtures, or offline checks for routine verification. Do not run paid APIs, long training jobs, infrastructure provisioning, or deployments without authorization for that work.
6. Report what changed, the commands run, their results, and any checks skipped because credentials, hardware, network access, or dependencies were unavailable. Never imply that unexecuted checks passed.

Do not assume exact output from live LLM calls. Use deterministic tests for surrounding logic and documented evaluation criteria for model behavior.

## Contributions and community discussions

- Keep a contribution focused on one example, resource, or coherent improvement.
- A pull request should explain the learning goal or problem, the category/example path, setup changes, validation, and relevant limitations or costs.
- Include a community topic link when available. A missing discussion should not prevent preparing a contribution; never fabricate a URL.
- When preparing a community post, include what the example teaches, how to run it, a direct code link, and questions or trade-offs readers can discuss. Contributors can link the merged code in their post and add the discussion link back to the example README.
- Writing files is not permission to publish a community post, push changes, or merge a pull request. Perform those actions when the user requests or authorizes them.
- Keep this guide aligned with the actual repository. Do not add speculative commands, infrastructure, or processes.

## Commit conventions

Use Conventional Commits: `<type>(optional-scope): <short description>`.

- `feat:` adds a feature or runnable example.
- `fix:` fixes a bug; use this instead of `bug:`.
- `chore:` covers repository setup, maintenance, and tooling.
- `docs:` changes documentation only.
- `test:` adds or updates tests and evaluation coverage.
- `refactor:` restructures code without changing its behavior.
- `perf:` improves performance.
- `build:` changes the build system or dependencies; `ci:` changes continuous integration.

Use `chore: initialize repository structure` for the initial scaffold, rather than an `initial commit:` prefix. Commit the scaffold separately from project implementations. Keep each later commit focused on one coherent change, with an imperative description such as `feat(agents): add Gemini and Jev travel planner`. Avoid combining unrelated work in one commit.

Rewrite published history only when explicitly authorized. When authorized, verify the remote head and use an explicit `--force-with-lease` so concurrent remote changes are not overwritten.

## Agent entry points

`AGENTS.md` is the shared instruction source. The root `CLAUDE.md` imports it for Claude Code. If another tool requires its own instruction file, use a thin reference supported by that tool rather than duplicating this guide.
