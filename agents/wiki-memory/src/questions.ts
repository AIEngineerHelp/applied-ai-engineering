// The three questions in step 3, the facts a correct answer needs, and the statements that would
// mislead a reader. Patterns match whole statements, not bare numbers, so a sentence that mentions
// an old value while saying it was replaced ("lowered from 100 to 50") is not counted as wrong.

import type { FactCheck } from "./retrieve.ts";

export interface Question {
  id: string;
  text: string;
  facts: FactCheck[];
  /** A scripted answer built from the wiki pages, written by hand. Not model output. */
  wikiAnswer: string;
}

export const QUESTIONS: Question[] = [
  {
    id: "retention",
    text: "How long are customer exports kept?",
    facts: [
      { kind: "needed", label: "90 days on Enterprise plans", pattern: /enterprise[^.]*90 days|90 days[^.]*enterprise/i },
      { kind: "needed", label: "30 days on other plans", pattern: /other plans[^.]*30 days|30 days[^.]*other plans/i },
      {
        kind: "wrong",
        label: "“kept for 7 days”",
        why: "From the unreviewed FAQ draft; 7 days is the download link's expiry",
        pattern: /export is kept for 7 days/i,
      },
      {
        kind: "wrong",
        label: "“30 days” for every plan",
        why: "The kickoff and design doc predate the 90-day Enterprise period",
        pattern: /files are kept for 30 days, then deleted|deletes export files 30 days after/i,
      },
    ],
    wikiAnswer:
      "Since 1 May 2026, export files are kept for 90 days on Enterprise plans and 30 days on all other plans. The emailed download link expires after 7 days; customers can request a new link while the file exists. The draft help-centre FAQ says 7 days, which is being corrected. Sources: export-retention, src-support-thread, src-faq-draft.",
  },
  {
    id: "rate",
    text: "What request rate does the export job use against the Billing API?",
    facts: [
      { kind: "needed", label: "Job sends 40 requests per second", pattern: /40 requests per second/i },
      { kind: "needed", label: "Limit is 50 requests per second", pattern: /limit of 50|(to|is) 50 requests per second|50 requests per second limit/i },
      {
        kind: "wrong",
        label: "“call it at 80 requests per second”",
        why: "The March plan; cut to 40 after INC-482",
        pattern: /will call it at 80 requests per second/i,
      },
      {
        kind: "wrong",
        label: "“allows 100 requests per second”",
        why: "The limit was lowered to 50 on 3 April",
        pattern: /allows 100 requests per second/i,
      },
    ],
    wikiAnswer:
      "The nightly job calls the Billing API at 40 requests per second and backs off on HTTP 429. The limit has been 50 requests per second per client since 3 April 2026; the March design's 80 (under a limit of 100) was superseded after INC-482. Sources: ledger-export, billing-api, src-inc-482.",
  },
  {
    id: "incident",
    text: "Why did the nightly exports fail in April?",
    facts: [
      { kind: "needed", label: "Billing API limit was lowered to 50", pattern: /from 100 to 50/i },
      { kind: "needed", label: "The job still sent 80 and got HTTP 429", pattern: /429/i },
    ],
    wikiAnswer:
      "On 3 April 2026 the Payments team halved the Billing API limit to 50 requests per second. The export job still sent 80, was rejected with HTTP 429 and failed on 4, 5 and 6 April, delaying about 210 requests. Sources: inc-482, src-inc-482.",
  },
];
