// Parsing the synthesis agent's markdown into a Report. Pure functions, safe to
// use in the browser (the chat UI parses the streaming draft the same way).
import type { Report } from "./types.ts";

/** Parses the streamed markdown into a Report; tolerant of small format slips. */
export function parseReport(md: string, fallbackTitle: string): Report {
  const text = md.replace(/\r/g, "").trim();
  const confidence = (text.match(/^\s*\**confidence\**:?\**\s*\**(low|moderate|high)/im)?.[1]?.toLowerCase() ?? "low") as Report["confidence"];
  const body = text.replace(/^\s*\**confidence\**:?.*$/im, "").trim();
  const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallbackTitle;
  const afterTitle = body.replace(/^#\s+.+$/m, "").trim();
  const [lead, ...rest] = afterTitle.split(/^##\s+/m);
  const sections: Report["sections"] = [];
  let limitations: string[] = [];
  for (const chunk of rest) {
    const [heading, ...lines] = chunk.split("\n");
    const content = lines.join("\n").trim();
    if (/^limitations?/i.test(heading.trim())) {
      limitations = content
        .split("\n")
        .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
        .filter(Boolean);
    } else if (content) sections.push({ heading: heading.trim(), body: content });
  }
  return { title, answer: lead.trim(), sections, limitations, confidence };
}

/** The markdown so far, without a trailing half-written citation, for live display. */
export function draftForDisplay(md: string): string {
  return md.replace(/\[[^\]\n]*$/, "");
}

