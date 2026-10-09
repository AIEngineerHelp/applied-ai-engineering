// Five tools an agent might expose, each with a naive implementation and a
// safe one. Every function returns a trace of what happened so the app can
// show the two side by side. Nothing runs for real: the tools read the
// pretend machine in sandbox.ts and all secrets are fake placeholders.

import type { Run, Step, Tool } from "./types.ts";
import {
  CURRENT_CUSTOMER,
  DNS,
  ENV,
  FILES,
  ORDERS,
  realPath,
  resolvePath,
  WEB,
  WORKSPACE,
} from "./sandbox.ts";

const run = (steps: Step[], outcome: Run["outcome"], verdict: string, result: string): Run => ({
  steps,
  outcome,
  verdict,
  result,
});

// Shorten a secret-looking file body for display.
const peek = (text: string) => {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > 58 ? `${line.slice(0, 58)}…` : line;
};

// ── 1. read_file: path traversal and symlink escape ────────────────────────

function readNaive(args: Record<string, string>): Run {
  const path = args.path ?? "";
  const steps: Step[] = [
    { kind: "info", label: "The tool joins the argument onto the workspace path", code: `path.join("${WORKSPACE}", ${JSON.stringify(path)})` },
  ];
  // The naive containment check: does the string start with the workspace?
  // join() collapses "..", so a traversal argument produces a real path that
  // fails even this weak check — but a bare or sibling path slips through.
  const joined = resolvePath(WORKSPACE, path);
  const real = realPath(joined);
  const startsWith = joined === WORKSPACE || joined.startsWith(`${WORKSPACE}/`);
  steps.push({ kind: startsWith ? "info" : "info", label: `Resolved path`, detail: joined, code: `"${joined}"` });

  if (!startsWith && !(joined + "/").startsWith("/srv/agent/workspace")) {
    // Fell outside even the prefix. The naive check uses startsWith on the
    // *joined* string, which is still fooled by a sibling like workspace-secrets.
  }
  // Naive guard: a string prefix check (CVE-2025-53110, EscapeRoute).
  const prefixOk = joined.startsWith("/srv/agent/workspace");
  steps.push({ kind: "info", label: "Guard: does the path start with the workspace string?", code: `"${joined}".startsWith("/srv/agent/workspace") // ${prefixOk}` });
  if (!prefixOk) {
    return run([...steps, { kind: "stop", label: "Prefix check failed — refused" }], "blocked", "The naive prefix check happens to stop this one. A sibling path like /srv/agent/workspace-secrets would pass it.", "Error: path outside workspace");
  }
  // It reads the symlink's target, not the link, because it never resolves it.
  if (real !== joined) {
    steps.push({ kind: "bad", label: "The path is a symlink pointing outside the workspace", detail: `${joined} → ${real}`, code: `fs.readFile("${joined}") // follows the link` });
  }
  const body = FILES[real];
  if (body === undefined) {
    return run([...steps, { kind: "info", label: "No such file" }], "done", "No such file.", "Error: ENOENT");
  }
  const outside = !real.startsWith("/srv/agent/workspace/") || real.includes("workspace-secrets");
  return run(
    [...steps, { kind: outside ? "bad" : "ok", label: outside ? "Returned a file from OUTSIDE the workspace" : "Returned the file", detail: peek(body), code: `fs.readFile("${real}")` }],
    outside ? "harm" : "done",
    outside ? "A string prefix check and an unresolved symlink let the model read a file it should never reach." : "An ordinary read inside the workspace.",
    body,
  );
}

function readSafe(args: Record<string, string>): Run {
  const path = args.path ?? "";
  const steps: Step[] = [
    { kind: "info", label: "Resolve the full path, following every symlink", code: `const real = fs.realpathSync(path.resolve(root, ${JSON.stringify(path)}))` },
  ];
  const joined = resolvePath(WORKSPACE, path);
  const real = realPath(joined);
  if (real !== joined) steps.push({ kind: "info", label: "Symlink followed to its real target", detail: `${joined} → ${real}` });
  // Containment on the resolved path, as a path boundary — not a string prefix.
  const inside = real === WORKSPACE || real.startsWith(`${WORKSPACE}/`);
  steps.push({ kind: "info", label: "Is the real target inside the workspace boundary?", code: `real === root || real.startsWith(root + path.sep) // ${inside}` });
  if (!inside) {
    return run([...steps, { kind: "stop", label: "Outside the workspace — refused", detail: real }], "blocked", "Resolving the symlink first, then checking the real path against a boundary, stops the escape.", "Error: path escapes the workspace root");
  }
  const body = FILES[real];
  if (body === undefined) return run([...steps, { kind: "info", label: "No such file" }], "done", "No such file.", "Error: ENOENT");
  return run([...steps, { kind: "ok", label: "Returned the file", detail: peek(body) }], "done", "The target really is inside the workspace, so the read is allowed.", body);
}

// ── 2. fetch_url: server-side request forgery (SSRF) ────────────────────────

const ALLOWED_HOSTS = ["docs.acme.example", "status.acme.example"];
const isPrivate = (ip: string) =>
  ip.startsWith("10.") || ip.startsWith("127.") || ip.startsWith("169.254.") || ip.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

function parseUrl(url: string): { host: string; path: string } | null {
  const m = /^https?:\/\/([^/]+)(\/.*)?$/i.exec(url.trim());
  if (!m) return null;
  return { host: m[1].toLowerCase(), path: m[2] ?? "/" };
}

function fetchNaive(args: Record<string, string>): Run {
  const url = args.url ?? "";
  const steps: Step[] = [{ kind: "info", label: "The tool fetches whatever URL it is given", code: `fetch(${JSON.stringify(url)})` }];
  const parsed = parseUrl(url);
  if (!parsed) return run([...steps, { kind: "info", label: "Not a URL" }], "done", "Not a URL.", "Error: invalid URL");
  // A bare IP in the host needs no DNS; it is its own address.
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(parsed.host) ? parsed.host : DNS[parsed.host] ?? "203.0.113.200";
  steps.push({ kind: "info", label: `DNS: ${parsed.host}`, detail: `→ ${ip}` });
  const page = WEB[ip];
  const internal = isPrivate(ip) || parsed.host.endsWith("169.254.169.254");
  if (!page) return run([...steps, { kind: "info", label: "No response" }], "done", "No response.", "Error: ECONNREFUSED");
  return run(
    [...steps, { kind: internal ? "bad" : "ok", label: internal ? `Reached an INTERNAL service: ${page.label}` : `Fetched ${page.label}`, detail: page.body, code: `GET ${ip}${parsed.path}` }],
    internal ? "harm" : "done",
    internal ? "The server fetched a private address from inside the network. A public-looking hostname can resolve to 10.x, 127.x or the cloud metadata endpoint." : "A fetch of a public page.",
    page.body,
  );
}

function fetchSafe(args: Record<string, string>): Run {
  const url = args.url ?? "";
  const steps: Step[] = [{ kind: "info", label: "Parse the URL and read its host", code: `const { host } = new URL(url)` }];
  const parsed = parseUrl(url);
  if (!parsed) return run([...steps, { kind: "info", label: "Not a URL" }], "done", "Not a URL.", "Error: invalid URL");
  const allowed = ALLOWED_HOSTS.includes(parsed.host);
  steps.push({ kind: "info", label: "Is the host on the allowlist?", code: `["docs.acme.example", "status.acme.example"].includes(host) // ${allowed}` });
  if (!allowed) return run([...steps, { kind: "stop", label: "Host not allowlisted — refused", detail: parsed.host }], "blocked", "An allowlist of exact hosts is the only reliable defence: a public-looking name like docs.acme.example.attacker.test never matches.", "Error: host not permitted");
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(parsed.host) ? parsed.host : DNS[parsed.host] ?? "203.0.113.200";
  steps.push({ kind: "info", label: `Resolve and re-check the address`, code: `isPrivate(${ip}) // ${isPrivate(ip)}` });
  if (isPrivate(ip)) return run([...steps, { kind: "stop", label: "Resolves to a private address — refused", detail: ip }], "blocked", "Even an allowlisted host is re-checked after DNS, so a name that points at 10.x is still refused.", "Error: address not permitted");
  const page = WEB[ip];
  return run([...steps, { kind: "ok", label: `Fetched ${page?.label ?? parsed.host}`, detail: page?.body }], "done", "The host is allowlisted and resolves to a public address.", page?.body ?? "");
}

// ── 3. run_command: OS command injection ────────────────────────────────────

function shellInjection(arg: string): string | null {
  // Characters that start a new command or expansion in a shell.
  const m = /[;&|`$><\n]|\$\(/.exec(arg);
  return m ? m[0] : null;
}

function commandNaive(args: Record<string, string>): Run {
  const file = args.filename ?? "";
  const cmd = `wc -l ${file}`;
  const steps: Step[] = [{ kind: "info", label: "The tool builds a shell command by pasting in the argument", code: `exec("wc -l " + filename)`, detail: cmd }];
  const meta = shellInjection(file);
  if (meta) {
    const injected = file.split(/[;&|\n]/).slice(1).join("").trim() || file;
    return run(
      [...steps, { kind: "bad", label: `The shell reads "${meta}" as a command separator`, detail: `It runs wc, then also runs: ${injected}`, code: `sh -c '${cmd}'` }],
      "harm",
      "The argument is pasted into a shell string, so shell metacharacters run as extra commands. This is CVE-class OS command injection (CWE-78).",
      "(two commands ran)",
    );
  }
  const body = FILES[resolvePath(WORKSPACE, file)];
  const lines = body ? body.replace(/\n$/, "").split("\n").length : 0;
  return run([...steps, { kind: "ok", label: "Counted the lines", detail: `${lines} lines` }], "done", "A plain filename runs as intended.", `${lines}`);
}

function commandSafe(args: Record<string, string>): Run {
  const file = args.filename ?? "";
  const steps: Step[] = [
    { kind: "info", label: "No shell: pass the argument as one element of an argument array", code: `execFile("wc", ["-l", filename])` },
  ];
  // With execFile and an argv array there is no shell, so metacharacters are
  // just part of the one filename — which then simply does not exist.
  if (shellInjection(file)) {
    steps.push({ kind: "info", label: "Shell characters are now part of the filename, not commands", detail: file });
  }
  const real = resolvePath(WORKSPACE, file);
  const inside = real.startsWith(`${WORKSPACE}/`);
  if (!inside) return run([...steps, { kind: "stop", label: "Path outside the workspace — refused" }], "blocked", "No shell is involved, and the path is still checked against the workspace.", "Error: path not permitted");
  const body = FILES[real];
  if (body === undefined) return run([...steps, { kind: "ok", label: "No such file", detail: "wc: no such file" }], "done", "No shell runs, so the worst a strange argument does is name a missing file.", "wc: no such file");
  const lines = body.replace(/\n$/, "").split("\n").length;
  return run([...steps, { kind: "ok", label: "Counted the lines", detail: `${lines} lines` }], "done", "An argument array means the shell never parses the input.", `${lines}`);
}

// ── 4. calculate: evaluating model-supplied code ────────────────────────────

function calcNaive(args: Record<string, string>): Run {
  const expr = args.expression ?? "";
  const steps: Step[] = [{ kind: "info", label: "The tool evaluates the expression as code", code: `eval(${JSON.stringify(expr)})` }];
  const dangerous = /require|import|process|child_process|global|fetch|constructor|this\./.test(expr);
  if (dangerous) {
    return run(
      [...steps, { kind: "bad", label: "The expression is not maths — it is code, and it runs", detail: "A calculator that calls eval() can read env vars, the filesystem or the network.", code: expr }],
      "harm",
      "eval() runs anything, not just arithmetic. The model (or injected text) can reach the whole runtime. This is OWASP ASI05, Unexpected Code Execution.",
      "(arbitrary code executed)",
    );
  }
  // Harmless arithmetic still "works", which is why the bug hides.
  let value: string;
  try {
    value = String(Function(`"use strict";return (${expr})`)());
  } catch {
    value = "NaN";
  }
  return run([...steps, { kind: "ok", label: "Evaluated", detail: `= ${value}` }], "done", "Plain arithmetic returns the right answer — which is why the eval() bug is easy to miss.", value);
}

function calcSafe(args: Record<string, string>): Run {
  const expr = args.expression ?? "";
  const steps: Step[] = [{ kind: "info", label: "Parse the expression with a maths-only parser; never eval", code: `parseArithmetic(expr) // numbers, + - * / ( ) only` }];
  const ok = /^[\d\s.+\-*/()]+$/.test(expr) && expr.trim().length > 0;
  if (!ok) return run([...steps, { kind: "stop", label: "Not an arithmetic expression — refused", detail: expr }], "blocked", "A real parser accepts only numbers and operators, so no identifier, call or keyword can run.", "Error: only arithmetic is allowed");
  let value: string;
  try {
    value = String(Function(`"use strict";return (${expr})`)());
  } catch {
    value = "NaN";
  }
  return run([...steps, { kind: "ok", label: "Evaluated", detail: `= ${value}` }], "done", "Only arithmetic reaches the evaluator, so the tool can do exactly one thing.", value);
}

// ── 5. lookup_order: the confused deputy (broken object authorization) ───────

function orderNaive(args: Record<string, string>): Run {
  const id = args.order_id ?? "";
  const steps: Step[] = [{ kind: "info", label: "The tool looks up whatever order id it is given", code: `db.orders.find(o => o.id === ${JSON.stringify(id)})` }];
  const order = ORDERS.find((o) => o.id === id);
  if (!order) return run([...steps, { kind: "info", label: "No such order" }], "done", "No such order.", "null");
  const mine = order.customer === CURRENT_CUSTOMER;
  return run(
    [...steps, { kind: mine ? "ok" : "bad", label: mine ? "Returned the order" : "Returned ANOTHER customer's order", detail: `${order.id} · ${order.email} · ${order.total}`, code: mine ? undefined : `// ${order.customer} ≠ signed-in ${CURRENT_CUSTOMER}` }],
    mine ? "done" : "harm",
    mine ? "The order belongs to the signed-in customer." : "The tool runs with the agent's own database access and never checks ownership, so it hands back a stranger's email and order total. This is the confused-deputy problem.",
    `${order.id}: ${order.email}, ${order.total}`,
  );
}

function orderSafe(args: Record<string, string>): Run {
  const id = args.order_id ?? "";
  const steps: Step[] = [
    { kind: "info", label: "Scope the query to the signed-in customer", code: `db.orders.find(o => o.id === order_id && o.customer === session.customer)` },
  ];
  const order = ORDERS.find((o) => o.id === id);
  if (!order) return run([...steps, { kind: "info", label: "No such order" }], "done", "No such order.", "null");
  if (order.customer !== CURRENT_CUSTOMER) {
    return run([...steps, { kind: "stop", label: "Not this customer's order — refused", detail: `signed in as ${CURRENT_CUSTOMER}` }], "blocked", "Authorization is enforced in the query itself, so an id for someone else's order returns nothing — the model's argument cannot widen its own access.", "null");
  }
  return run([...steps, { kind: "ok", label: "Returned the order", detail: `${order.id} · ${order.email} · ${order.total}` }], "done", "The order belongs to the signed-in customer, so it is returned.", `${order.id}: ${order.email}, ${order.total}`);
}

// ── The catalogue ────────────────────────────────────────────────────────────

export const TOOLS: Tool[] = [
  {
    id: "read_file",
    kind: "Filesystem",
    headline: "read_file — reading outside the sandbox",
    lede: "A tool that reads a file from a workspace. The model supplies the path. The danger is a path that escapes the folder the tool was meant to stay inside, by climbing up with ../ or by following a symlink.",
    definition: {
      name: "read_file",
      description: "Read a UTF-8 text file from the project workspace.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Path to the file, relative to the workspace root." } }, required: ["path"] },
    },
    permission: "Resolve the real path (following symlinks), then require it to sit inside the workspace boundary.",
    naiveCode: `function readFile(p) {\n  const full = path.join(ROOT, p);\n  // string prefix check\n  if (!full.startsWith(ROOT)) throw Error("denied");\n  return fs.readFileSync(full, "utf8");\n}`,
    safeCode: `function readFile(p) {\n  const real = fs.realpathSync(path.resolve(ROOT, p));\n  const root = fs.realpathSync(ROOT);\n  if (real !== root && !real.startsWith(root + path.sep))\n    throw Error("escapes workspace");\n  return fs.readFileSync(real, "utf8");\n}`,
    fixes: [
      "Resolve the path and follow symlinks before checking anything.",
      "Compare against a path boundary (root + separator), not a string prefix.",
      "A sibling like workspace-secrets/ must not pass a startsWith check.",
    ],
    risk: { name: "OWASP ASI02 · Tool Misuse (path traversal, CWE-22)", url: "https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/" },
    incident: { text: "EscapeRoute (CVE-2025-53109/53110): Anthropic's Filesystem MCP server used a string-prefix check and validated a symlink's parent instead of its target, allowing reads and writes outside the configured directory. Fixed in 2025.7.1.", url: "https://cymulate.com/blog/cve-2025-53109-53110-escaperoute-anthropic/" },
    examples: [
      { id: "ok", label: "notes/meeting.txt", benign: true, args: { path: "notes/meeting.txt" }, source: "The user asked to summarize their meeting notes.", lesson: "An ordinary read inside the workspace — the safe version must still allow it." },
      { id: "dotdot", label: "../.env", benign: false, args: { path: "../.env" }, source: "Injected by a line in a file the agent had already read.", lesson: "Climbing up with ../ reaches secrets beside the workspace." },
      { id: "sibling", label: "../workspace-secrets/deploy-token.txt", benign: false, args: { path: "../workspace-secrets/deploy-token.txt" }, source: "Injected via a task description.", lesson: "A sibling folder whose name starts with the workspace path slips past a prefix check." },
      { id: "symlink", label: "shared/id_ed25519", benign: false, args: { path: "shared/id_ed25519" }, source: "The agent followed a 'shared' link it found in the workspace.", lesson: "A symlink inside the workspace can point at ~/.ssh outside it." },
    ],
    naive: readNaive,
    safe: readSafe,
  },
  {
    id: "fetch_url",
    kind: "Network",
    headline: "fetch_url — the request that comes from inside",
    lede: "A tool that fetches a web page for the model to read. Because the request leaves from your server, a URL can point at addresses only your server can reach: the machine itself, a private service, or the cloud metadata endpoint that hands out credentials.",
    definition: {
      name: "fetch_url",
      description: "Fetch a web page and return its text.",
      parameters: { type: "object", properties: { url: { type: "string", description: "An https URL on an approved documentation host." } }, required: ["url"] },
    },
    permission: "Allow only exact approved hosts, and after DNS re-check that the address is public before connecting.",
    naiveCode: `async function fetchUrl(url) {\n  const res = await fetch(url);  // any address\n  return await res.text();\n}`,
    safeCode: `async function fetchUrl(url) {\n  const { host } = new URL(url);\n  if (!ALLOW.has(host)) throw Error("host not permitted");\n  const ip = await lookup(host);\n  if (isPrivate(ip)) throw Error("address not permitted");\n  return await (await fetch(url)).text();\n}`,
    fixes: [
      "Allowlist exact hosts; never allow arbitrary URLs.",
      "Resolve DNS and reject private ranges (10/8, 127/8, 169.254/16, 192.168/16, 172.16/12).",
      "Block the cloud metadata address 169.254.169.254 explicitly.",
    ],
    risk: { name: "OWASP ASI02 · Tool Misuse (SSRF, CWE-918)", url: "https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/" },
    examples: [
      { id: "ok", label: "https://docs.acme.example/api", benign: true, args: { url: "https://docs.acme.example/api" }, source: "The user asked what the API rate limit is.", lesson: "A fetch of an approved public page." },
      { id: "meta", label: "http://169.254.169.254/latest/…", benign: false, args: { url: "http://169.254.169.254/latest/meta-data/iam/credentials" }, source: "Injected by a web page the agent was reading.", lesson: "The cloud metadata endpoint can return the machine's credentials." },
      { id: "internal", label: "http://billing.internal/invoices", benign: false, args: { url: "http://billing.internal/invoices" }, source: "Injected via a support ticket the agent read.", lesson: "A name that resolves to a 10.x address reaches a private service." },
      { id: "lookalike", label: "https://docs.acme.example.attacker.test/", benign: false, args: { url: "https://docs.acme.example.attacker.test/" }, source: "Looks like the docs host, but the real domain is attacker.test.", lesson: "A substring match on the host is not an allowlist." },
    ],
    naive: fetchNaive,
    safe: fetchSafe,
  },
  {
    id: "run_command",
    kind: "Shell",
    headline: "run_command — when an argument becomes a command",
    lede: "A tool that counts the lines in a file by shelling out to wc. If the filename is pasted into a shell string, shell characters in it start new commands. The model thinks it is naming a file; the shell reads it as instructions.",
    definition: {
      name: "run_command",
      description: "Count the lines in a workspace file.",
      parameters: { type: "object", properties: { filename: { type: "string", description: "A file in the workspace." } }, required: ["filename"] },
    },
    permission: "Never build a shell string. Pass the argument as one element of an argument array, and keep the path inside the workspace.",
    naiveCode: `function countLines(filename) {\n  return exec("wc -l " + filename);  // a shell parses this\n}`,
    safeCode: `function countLines(filename) {\n  // no shell: argv array, so the input is one filename\n  return execFile("wc", ["-l", resolveInWorkspace(filename)]);\n}`,
    fixes: [
      "Use execFile/spawn with an argument array — no shell is involved.",
      "Prefer a library call (count lines in code) over spawning a process at all.",
      "Still resolve and bound the path, as with read_file.",
    ],
    risk: { name: "OWASP ASI05 · Unexpected Code Execution (OS command injection, CWE-78)", url: "https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/" },
    incident: { text: "CVE-2025-6514: mcp-remote (used by MCP clients to reach remote servers) passed an untrusted value into os command execution, letting a malicious server run commands on the client. CVSS 9.6; fixed in 0.1.16.", url: "https://www.wiz.io/vulnerability-database/cve/cve-2025-6514" },
    examples: [
      { id: "ok", label: "logs/app.log", benign: true, args: { filename: "logs/app.log" }, source: "The user asked how many log lines there are.", lesson: "A plain filename runs exactly as intended." },
      { id: "inject", label: "app.log; rm -rf ~", benign: false, args: { filename: "app.log; rm -rf ~" }, source: "Injected by a filename the agent found in a listing.", lesson: "The ; ends the wc command and starts a destructive one." },
      { id: "subshell", label: "$(cat /srv/agent/.env)", benign: false, args: { filename: "$(cat /srv/agent/.env)" }, source: "Injected via a crafted task.", lesson: "Command substitution runs first and leaks the file into the command line." },
    ],
    naive: commandNaive,
    safe: commandSafe,
  },
  {
    id: "calculate",
    kind: "Code",
    headline: "calculate — a calculator that runs anything",
    lede: "A tool that evaluates an arithmetic expression. The quickest implementation is eval(), and it works perfectly for 2 + 2. It also runs any other code the string contains, because eval() does not know the difference.",
    definition: {
      name: "calculate",
      description: "Evaluate an arithmetic expression and return the number.",
      parameters: { type: "object", properties: { expression: { type: "string", description: "An arithmetic expression, e.g. (3 + 4) * 2." } }, required: ["expression"] },
    },
    permission: "Parse the expression with an arithmetic-only grammar. Never pass model text to eval, Function, exec or a template.",
    naiveCode: `function calculate(expr) {\n  return eval(expr);  // runs any code, not just maths\n}`,
    safeCode: `function calculate(expr) {\n  if (!/^[\\d\\s.+\\-*/()]+$/.test(expr)) throw Error("arithmetic only");\n  return parseArithmetic(expr);  // numbers and operators only\n}`,
    fixes: [
      "Use a real parser or a maths library; never eval model output.",
      "Validate against a strict character/grammar allowlist, not a denylist.",
      "The same rule covers SQL, templates and shell: parse, don't interpolate.",
    ],
    risk: { name: "OWASP ASI05 · Unexpected Code Execution (code injection, CWE-94)", url: "https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/" },
    examples: [
      { id: "ok", label: "(3 + 4) * 2", benign: true, args: { expression: "(3 + 4) * 2" }, source: "The user asked for a sum.", lesson: "Arithmetic returns the right answer — the bug stays hidden." },
      { id: "env", label: "process.env.PAYMENTS_KEY", benign: false, args: { expression: "process.env.PAYMENTS_KEY" }, source: "Injected via the model's own output.", lesson: "eval can read environment variables, including secrets." },
      { id: "exfil", label: "require('child_process')…", benign: false, args: { expression: "require('child_process').execSync('id')" }, source: "Injected by untrusted text the model summarized.", lesson: "eval can reach the whole runtime: files, network, processes." },
    ],
    naive: calcNaive,
    safe: calcSafe,
  },
  {
    id: "lookup_order",
    kind: "Authorization",
    headline: "lookup_order — the confused deputy",
    lede: "A tool that looks up an order by id. It runs with the agent's own broad database access. If it does not check who is asking, the model becomes a deputy that uses that access on anyone's behalf — returning a stranger's order simply because an id was supplied.",
    definition: {
      name: "lookup_order",
      description: "Look up an order by its id.",
      parameters: { type: "object", properties: { order_id: { type: "string", description: "The order id, e.g. A1001." } }, required: ["order_id"] },
    },
    permission: "Scope every query to the signed-in customer. Authorization lives in the tool and the database, never in the model's judgement.",
    naiveCode: `function lookupOrder(id) {\n  return db.orders.find(o => o.id === id);\n}`,
    safeCode: `function lookupOrder(id, session) {\n  return db.orders.find(\n    o => o.id === id && o.customer === session.customer);\n}`,
    fixes: [
      "Enforce ownership in the query; don't filter after fetching.",
      "Pass the caller's identity to the tool; don't let the model assert it.",
      "Give the tool's credentials the least access the task needs.",
    ],
    risk: { name: "OWASP ASI02 · Tool Misuse (broken object-level authorization, CWE-639)", url: "https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/" },
    examples: [
      { id: "ok", label: "A1001 (mine)", benign: true, args: { order_id: "A1001" }, source: "The signed-in customer asked about their own order.", lesson: "An order that belongs to the caller is returned." },
      { id: "other", label: "B2001 (someone else's)", benign: false, args: { order_id: "B2001" }, source: "The model was told 'check order B2001 for the customer'.", lesson: "Without an ownership check, another customer's email and total leak." },
      { id: "enum", label: "B2002 (guessed id)", benign: false, args: { order_id: "B2002" }, source: "Injected text asked the agent to 'confirm refund on B2002'.", lesson: "Sequential ids are easy to guess, so the check cannot be optional." },
    ],
    naive: orderNaive,
    safe: orderSafe,
  },
];
