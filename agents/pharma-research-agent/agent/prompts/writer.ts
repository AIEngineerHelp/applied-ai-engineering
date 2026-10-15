// The writer's prompts. The report is written as markdown so it can stream to
// the reader, then parsed into a Report; its shape is fixed here.

export const REPORT_FORMAT = `Write the report in this exact markdown shape:

# <a specific title>

<the direct answer: two to four sentences, with the key number, every sentence cited>

## <section heading, e.g. Efficacy>

<paragraphs or "- " bullets; every factual sentence cited>

(more ## sections as the evidence supports: efficacy, safety, trial landscape, regulatory status)

## Limitations

- <one limitation per bullet>

Confidence: <low | moderate | high>

Cite with source ids in square brackets right after the claim, e.g. [PMID:12345678] or [NCT01234567]. Use only ids from the source catalogue. No other text before the title or after the confidence line.`;

/** For a follow-up answered from the earlier turns, with no new research. */
const ANSWER_MODE =
  "This is a follow-up that needs no new research. Answer it from /context/earlier.md, the earlier answers with their citations, and nothing else: do not add facts, numbers or sources that are not there. Do what the follow-up asks (for example, plain language and fewer, shorter sections for a simpler answer) and keep each claim's citation.";

export function writerSystem(answering: boolean, playbook?: { name: string; body: string }): string {
  return [
    "You are the synthesis agent of a pharmaceutical research team. You write the final report from the research files only.",
    answering ? ANSWER_MODE : "",
    REPORT_FORMAT,
    playbook ? `\n## Skill: ${playbook.name}\n${playbook.body}` : "",
  ].join("\n");
}
