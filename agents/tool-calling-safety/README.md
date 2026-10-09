# Tools, tool calling, and unsafe tool execution

An agent is a model that can call tools. A tool is a **name**, a **description** and a **JSON schema** for its arguments; the model never runs anything, it only writes text asking for a call, and *your code* runs it and feeds the result back. That one step — step 2 of the loop — is where safety is won or lost, because the model's arguments are untrusted input and may come from a web page or a file the agent just read, not from the user.

This example is a small web app. Pick one of five tools and a call the model might make, and see two implementations run side by side:

- **A naive implementation** — the shortest code that works — and what it actually does with a malicious argument: read a file outside its folder, fetch an internal address, run an injected shell command, evaluate arbitrary code, or return another customer's data.
- **A safe implementation** that still does the real job for ordinary calls, with the permission check and the fix shown inline.
- **The full trace** of each run: the steps taken, the exact moment harm happens, and the point where a safeguard refuses.

It runs entirely in the browser. Nothing executes for real: every tool reads a pretend machine in `src/sandbox.ts`, and every secret is a fake placeholder. **Live:** [tool-calling-safety.vercel.app](https://tool-calling-safety.vercel.app).

## The five tools

| Tool | The class of bug | What the naive version does | The fix |
|---|---|---|---|
| `read_file` | Path traversal / symlink escape (CWE-22) | A string-prefix check passes a sibling folder, and an unresolved symlink points out of the workspace | Resolve the real path (follow symlinks), then check it against a path boundary, not a prefix |
| `fetch_url` | Server-side request forgery (CWE-918) | Fetches any URL, including `169.254.169.254` and private `10.x` services | Allowlist exact hosts; re-check the resolved address is public |
| `run_command` | OS command injection (CWE-78) | Pastes the filename into a shell string, so `;` starts a new command | Use an argument array (`execFile`), so no shell ever parses the input |
| `calculate` | Code injection (CWE-94) | Calls `eval()`, which runs any code, not just arithmetic | Parse with an arithmetic-only grammar; never `eval` model output |
| `lookup_order` | Broken object authorization / confused deputy (CWE-639) | Returns any order id, using the agent's own broad access | Scope the query to the signed-in caller in the query itself |

Each maps to a category in the [OWASP Top 10 for Agentic Applications (2026)](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/), published 9 December 2025: **ASI02 Tool Misuse** (path traversal, SSRF, broken authorization) and **ASI05 Unexpected Code Execution** (command and code injection). The permission principles — least functionality, least privilege, human approval for high-impact actions — follow [OWASP LLM06: Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/).

## Permissions, in one idea

Every tool call should pass three gates before it runs:

1. **Is this tool allowed here at all?** (allow / ask / deny — Claude Code's own permission modes are a real-world example.)
2. **Are the arguments in scope?** (which folders, which hosts, which rows — enforced in code, never left to the model's judgement.)
3. **Is this action reversible and low-stakes enough to run without a person?** (refunds over a threshold, writes after untrusted text has entered the context — pause for approval.)

A tool named `run_shell` fails gate 1 before anything executes: it is open-ended by construction, so it can never satisfy least privilege. Prefer the narrowest tool that does the task.

This example is deliberately about the **implementation** of a single tool call. Its companion, [agent guardrails](../../evaluations-reliability/agent-guardrails/README.md), covers the layers *around* the call — input classifiers, a tool policy, output filters and human approval — and measures what each one stops.

## It happened in the wild

- **EscapeRoute** ([CVE-2025-53109 / 53110](https://cymulate.com/blog/cve-2025-53109-53110-escaperoute-anthropic/)): Anthropic's Filesystem MCP server used a string-prefix containment check and validated a symlink's *parent* rather than its target, allowing reads and writes outside the configured directory. Fixed in `2025.7.1`. This is exactly the `read_file` example.
- **mcp-remote** ([CVE-2025-6514](https://www.wiz.io/vulnerability-database/cve/cve-2025-6514), CVSS 9.6): a value from an untrusted MCP server reached OS command execution on the client. Fixed in `0.1.16`. This is the `run_command` example.

## Run it

Requires Node.js 22.12 or later. From `agents/tool-calling-safety/`:

```bash
npm ci
npm start        # builds the app and serves it on http://127.0.0.1:4323 (PORT and HOST to change)
npm test         # the naive/safe behaviour of every tool and example
npm run check    # TypeScript type check
npm run export   # static copy in dist/ for deployment
```

Open a tool and call directly with URL parameters: `?tool=` (`read_file`, `fetch_url`, `run_command`, `calculate`, `lookup_order`) and `&call=` (an example id). For example, `http://127.0.0.1:4323/?tool=read_file&call=symlink`.

## How it is built

- `src/types.ts` — the shapes of a tool, an example call, and an execution trace.
- `src/sandbox.ts` — the pretend machine: files, a symlink, a DNS table, a web, an orders table and environment variables. All fake.
- `src/tools.ts` — the five tools, each with a `naive` and a `safe` function that return a trace. This is the file to read.
- `client/app.ts` — the UI: the tool-calling loop diagram, the tool rail, and the side-by-side runner.
- `tests/tools.test.ts` — asserts that benign calls work both ways, that the safe path never causes harm, and that each tool has a real naive vulnerability to demonstrate.

The tool-definition JSON shown in the app matches the shape every major provider uses (`name`, `description`, a JSON-schema `parameters` object). Check the current [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling) and [Claude tool use](https://docs.claude.com/en/docs/build-with-claude/tool-use) docs before copying a schema into real code, as the surrounding request format differs by provider.

## Sources

- OWASP GenAI Security Project, [Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) and [LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/).
- Cymulate Research Labs, [EscapeRoute (CVE-2025-53109/53110)](https://cymulate.com/blog/cve-2025-53109-53110-escaperoute-anthropic/).
- JFrog / Wiz, [CVE-2025-6514 in mcp-remote](https://www.wiz.io/vulnerability-database/cve/cve-2025-6514).
- CWE: [22](https://cwe.mitre.org/data/definitions/22.html) (path traversal), [78](https://cwe.mitre.org/data/definitions/78.html) (OS command injection), [94](https://cwe.mitre.org/data/definitions/94.html) (code injection), [918](https://cwe.mitre.org/data/definitions/918.html) (SSRF), [639](https://cwe.mitre.org/data/definitions/639.html) (broken object-level authorization).

Related community category: [Agents & Workflows](https://aiengineer.help/c/agents-workflows/7).
