# Anatomy of a harness

A model turns text into text. Everything that makes it an **agent** — what it sees on each call, where its commands run, how it splits up work and when it stops to ask a person — is the **harness**. As LangChain puts it: *if you're not the model, you're the harness.*

This example is a small web app that draws a harness as one isometric machine rather than boxes and arrows. The model is a sealed engine in the middle; the context window is a tray in front of it, one unit per 10k tokens; and eleven numbered parts sit around it. Press play and the machine works through one ordinary task — *"The checkout test has failed since Tuesday. Fix it and open a pull request."* — step by step. Then switch parts off and run it again: the missing part becomes a dashed ghost, and the run shows what goes wrong without it.

## The four jobs and the eleven parts

| Job | Part | Drawn as | Without it, in this run |
|---|---|---|---|
| **Context management** — what the model sees, inside a fixed window | 1 Skills | Card rack | All eight playbooks sit in the prompt from the first call (window ×3, bill ×2.4) |
| | 2 Memory | Filing cabinet | The agent misses the repo's UTC convention, redoes the fix, and saves nothing for next time |
| | 3 Summarization | Press | No effect here — until subagents and offloading are gone too; then the window overflows and the run stops |
| | 4 Context offloading | Chute | Every test log lands in the window in full (window ×5.1, bill ×2.3) |
| **Execution environment** — a computer to run code and keep files | 5 REPL | Terminal | The agent cannot run anything; the fix ships untested |
| | 6 Sandbox | Glass case | `npm ci` runs package install scripts on your own machine |
| | 7 File system | Shelves | Offloading, memory and scratch scripts all stop (window ×9.1, bill ×3.1) |
| | 8 Write & run code | Workbench | The agent re-runs the whole suite instead of a 12-line repro script |
| **Delegation** — split big work, keep track of it | 9 Planning | Peg board | The agent stops at the first green test and skips the full suite |
| | 10 Subagents | Small engines | The main agent reads 110k tokens of files itself (window ×6.7, bill ×4.1) |
| **Steering** — a person at the decisions that matter | 11 Human in the loop | Gate and lever | The change is pushed straight to `main`, unreviewed |

"Window" is the peak context window; "bill" is **tokens billed**: the size of the window at every model call, added up, including the subagent's own calls. Each call re-sends the whole window, so a large block that enters early is paid for once per call that follows. The page computes these tables live from the same run the figure plays.

## What it shows, and what it doesn't

- **The numbers are illustrative.** Token sizes are chosen to match common orders of magnitude for a coding agent; they are not measurements of any product, and the run is scripted, not a live model. The arithmetic over them — what is in the window at each call and what that adds up to — is exact for the script and covered by tests.
- **One path through the task.** A real agent branches and sometimes recovers on its own. Here each missing part has one fixed consequence.
- **Prompt caching is not modelled.** Cached prefixes lower the cost of carrying stable instructions, but they do not shrink the window.
- **Not every part.** Real harnesses also have system prompts, tool definitions, MCP servers, hooks/middleware and model routing. The figure shows the four jobs from the whiteboard sketch this example started from, not a complete parts list.

## Run it

Requires Node.js 22.12 or later. From `agents/harness-anatomy/`:

```bash
npm ci
npm start        # builds and serves http://127.0.0.1:4324 (PORT and HOST to change)
npm test         # the run model: window sums, billing, overflow, dependencies, each part's failure
npm run check    # TypeScript type check
npm run export   # static copy in dist/ for deployment
```

No API keys, no network calls beyond Google Fonts. In the app: <kbd>Space</kbd> plays or pauses, <kbd>←</kbd>/<kbd>→</kbd> step, <kbd>R</kbd> resets, and hovering a part (in the figure or the list) shows what it does. A machine can be linked with URL parameters, for example `?off=subagents,offloading,summarization&step=10` (the overflow), and `?theme=light` or `?theme=dark` forces a theme.

## How it is built

- `src/harness.ts` — the parts, their dependencies, and `run(installed)`: the task played step by step, returning every window, file, to-do and problem. This is the file to read.
- `client/figure.ts` — the machine: a small isometric projection (`box`, `cyl`, face-aligned `label`) and one function that draws the whole figure from a step. No libraries.
- `client/app.ts` — the transport, meters, parts list and the comparison tables in the article.
- `site/index.html` — the page and its text; `client/styles.css` — Tailwind CSS v4 plus the figure's materials for light and dark themes.
- `tests/harness.test.ts` — checks the run model.

The drawing style follows Ryan's [Anatomy](https://skills.wheresryan.sh/anatomy) skill for Claude Code: draw the machine whose working is the idea, with numbers coming from the same model that moves the parts.

## Sources

- Vivek Trivedy, LangChain, [The Anatomy of an Agent Harness](https://www.langchain.com/blog/the-anatomy-of-an-agent-harness), 10 March 2026.
- LangChain docs, [Agents](https://docs.langchain.com/oss/python/langchain/agents): execution environment, context management, subagents and steering.
- Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), 29 September 2025: compaction, structured note-taking, sub-agent architectures and progressive disclosure.
- Manus, [Context Engineering for AI Agents: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus): the file system as externalised, restorable context.

Related community category: [Agents & Workflows](https://aiengineer.help/c/agents-workflows/7).
