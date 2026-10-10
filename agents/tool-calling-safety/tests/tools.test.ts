import { test } from "node:test";
import assert from "node:assert/strict";

import { TOOLS } from "../src/tools.ts";
import type { Tool } from "../src/types.ts";

const byId = (id: string): Tool => {
  const t = TOOLS.find((x) => x.id === id);
  assert.ok(t, `tool ${id} exists`);
  return t;
};

test("every example runs safely on the safe implementation", () => {
  for (const tool of TOOLS) {
    for (const ex of tool.examples) {
      const safe = tool.safe(ex.args);
      assert.notEqual(safe.outcome, "harm", `${tool.id}/${ex.id} must never harm on the safe path`);
      if (ex.benign) {
        assert.equal(safe.outcome, "done", `${tool.id}/${ex.id} benign call should succeed safely`);
      } else {
        // A malicious call is either refused outright, or rendered harmless
        // (e.g. with no shell, an injected filename is just a missing file).
        assert.ok(["blocked", "done"].includes(safe.outcome), `${tool.id}/${ex.id} malicious call must not harm safely`);
      }
    }
  }
});

test("benign calls work naively; the safe path never harms, and prevents any naive harm", () => {
  for (const tool of TOOLS) {
    for (const ex of tool.examples) {
      const naive = tool.naive(ex.args);
      const safe = tool.safe(ex.args);
      if (ex.benign) {
        assert.equal(naive.outcome, "done", `${tool.id}/${ex.id} benign should work naively`);
      } else {
        assert.notEqual(safe.outcome, "harm", `${tool.id}/${ex.id} safe must not harm`);
        // Where the naive path caused harm, the safe path must prevent it.
        if (naive.outcome === "harm") {
          assert.ok(["blocked", "done"].includes(safe.outcome), `${tool.id}/${ex.id} safe prevents the naive harm`);
        }
      }
    }
  }
});

test("each tool has at least one malicious example that harms the naive implementation", () => {
  for (const tool of TOOLS) {
    const harms = tool.examples.filter((e) => !e.benign && tool.naive(e.args).outcome === "harm");
    assert.ok(harms.length >= 1, `${tool.id} demonstrates a real naive vulnerability`);
  }
});

test("read_file: prefix check is fooled by a sibling, boundary check is not", () => {
  const read = byId("read_file");
  const naive = read.naive({ path: "../workspace-secrets/deploy-token.txt" });
  assert.equal(naive.outcome, "harm");
  const safe = read.safe({ path: "../workspace-secrets/deploy-token.txt" });
  assert.equal(safe.outcome, "blocked");
});

test("read_file: a symlink inside the workspace escapes it naively", () => {
  const read = byId("read_file");
  assert.equal(read.naive({ path: "shared/id_ed25519" }).outcome, "harm");
  assert.equal(read.safe({ path: "shared/id_ed25519" }).outcome, "blocked");
});

test("fetch_url: a lookalike host is not on the allowlist", () => {
  const fetch = byId("fetch_url");
  assert.equal(fetch.safe({ url: "https://docs.acme.example.attacker.test/" }).outcome, "blocked");
  assert.equal(fetch.naive({ url: "http://169.254.169.254/latest/meta-data/" }).outcome, "harm");
});

test("run_command: a shell separator injects a command only without a shell array", () => {
  const cmd = byId("run_command");
  assert.equal(cmd.naive({ filename: "app.log; rm -rf ~" }).outcome, "harm");
  // No shell runs, so the injected text is just a filename that doesn't exist.
  assert.notEqual(cmd.safe({ filename: "app.log; rm -rf ~" }).outcome, "harm");
  // A plain filename works on both.
  assert.equal(cmd.naive({ filename: "logs/app.log" }).outcome, "done");
  assert.equal(cmd.safe({ filename: "logs/app.log" }).outcome, "done");
});

test("calculate: arithmetic works both ways; code only runs under eval", () => {
  const calc = byId("calculate");
  assert.equal(calc.naive({ expression: "(3 + 4) * 2" }).result, "14");
  assert.equal(calc.safe({ expression: "(3 + 4) * 2" }).result, "14");
  assert.equal(calc.naive({ expression: "require('child_process').execSync('id')" }).outcome, "harm");
  assert.equal(calc.safe({ expression: "require('child_process').execSync('id')" }).outcome, "blocked");
});

test("lookup_order: ownership is enforced in the safe query", () => {
  const order = byId("lookup_order");
  assert.equal(order.naive({ order_id: "B2001" }).outcome, "harm");
  assert.equal(order.safe({ order_id: "B2001" }).outcome, "blocked");
  assert.equal(order.safe({ order_id: "A1001" }).outcome, "done");
});

test("tool definitions are valid JSON-schema shapes with required fields present", () => {
  for (const tool of TOOLS) {
    const d = tool.definition;
    assert.ok(d.name && d.description, `${tool.id} has name and description`);
    for (const req of d.parameters.required) {
      assert.ok(d.parameters.properties[req], `${tool.id} required prop ${req} is declared`);
    }
  }
});
