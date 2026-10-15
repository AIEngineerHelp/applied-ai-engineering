import { test } from "node:test";
import assert from "node:assert/strict";
import { blocks, citationOrder, numbered, numbering, splitCitations } from "../lib/citations.ts";
import type { Report } from "../lib/research/types.ts";

const report: Report = {
  title: "t",
  answer: "Risk was not raised [PMID:2] [NCT01]. Labels warn [FDA:x].",
  sections: [{ heading: "h", body: "Pooled trials agree [PMID:2], [PMID:9]." }],
  limitations: ["Old data [WEB:1.2]."],
  confidence: "moderate",
};

test("sources are numbered in order of first citation", () => {
  assert.deepEqual(citationOrder(report), ["PMID:2", "NCT01", "FDA:x", "PMID:9", "WEB:1.2"]);
  assert.equal(numbering(report).get("PMID:9"), 4);
});

test("adjacent citations become one group, and render as [1, 2]", () => {
  const parts = splitCitations("A [PMID:2] [NCT01]. B");
  assert.deepEqual(parts, [{ kind: "text", text: "A" }, { kind: "cite", ids: ["PMID:2", "NCT01"] }, { kind: "text", text: ". B" }]);
  assert.equal(numbered(report.sections[0].body, numbering(report)), "Pooled trials agree [1, 4].");
});

test("prose splits into paragraphs and bullet lists", () => {
  assert.deepEqual(blocks("One.\n\n- a\n- b"), [{ kind: "p", items: ["One."] }, { kind: "ul", items: ["a", "b"] }]);
});
