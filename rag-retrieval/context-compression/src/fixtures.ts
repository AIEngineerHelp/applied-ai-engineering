import { terms, type Evidence } from "./compress.ts";

export interface Question {
  id: string;
  text: string;
  focus?: string;
  evidence: Evidence[];
  lesson: string;
}
export interface Passage {
  id: string;
  title: string;
  body: string;
}
export interface Scenario {
  id: string;
  title: string;
  kind: string;
  description: string;
  origin: string;
  passages: Passage[];
  questions: Question[];
}

export const scenarios: Scenario[] = [
  {
    id: "document",
    title: "Read a document",
    kind: "One-shot Q&A",
    origin: "Aster · customer handbook",
    description:
      "A whole handbook goes into the prompt. Keep the policy and the exception together.",
    passages: [
      {
        id: "overview",
        title: "About Aster",
        body: "Aster is a fictional workspace for small design teams. It combines project boards, shared files and client reviews in one place. The handbook was updated on 12 October 2026. Its examples are for learning, not an actual company's policies.\n\nWorkspace owners can invite teammates from the members page. Guests see only the projects shared with them. The dashboard opens on the project you visited most recently, and its colors can be changed in personal settings.",
      },
      {
        id: "plans",
        title: "Plans and billing",
        body: "The Starter plan costs $19 per workspace each month. The Studio plan costs $49 per workspace each month and adds unlimited client reviews. Annual billing includes a discount. Prices exclude local taxes.\n\nOwners receive a billing receipt by email after each successful payment. A failed payment is retried twice over seven days. Projects remain readable during that period. A new payment method can be added without contacting support.",
      },
      {
        id: "refunds",
        title: "Refund policy",
        body: "Annual subscriptions qualify for a full refund within 30 days of the first payment. Monthly subscriptions are not refundable. Submit a refund request from Billing with the workspace ID and the receipt number.\n\nException: after a workspace exports client archives, the annual subscription is not refundable, even within 30 days. This restriction applies because the export includes licensed design assets. Support may investigate duplicate charges separately; those are billing corrections, not subscription refunds.",
      },
      {
        id: "cancel",
        title: "Cancellation and retention",
        body: "Cancelling a subscription stops the next renewal. Cancellation does not automatically issue a refund. Access continues until the end of the paid billing period. The owner can reverse cancellation before that period ends.\n\nDeleted workspaces are held for 14 days before permanent removal. During that window, an owner can ask support to restore the workspace. After permanent removal, files cannot be recovered. Receipts remain available for accounting purposes.",
      },
      {
        id: "support",
        title: "Support and accessibility",
        body: "Support is available Monday through Friday, from 09:00 to 17:00 UTC. Studio workspaces have priority email support. Include the browser version and a screenshot when reporting a display issue. Never send passwords or private access tokens.\n\nKeyboard navigation is available throughout the dashboard. Press the slash key to open project search. Notification emails can be disabled independently of billing emails. Aster does not sell customer contact information to advertisers.",
      },
    ],
    questions: [
      {
        id: "refund",
        text: "Can I get a refund for an annual subscription after exporting client archives?",
        evidence: [
          {
            label: "The general eligibility rule",
            quote:
              "Annual subscriptions qualify for a full refund within 30 days of the first payment.",
          },
          {
            label: "The exception that changes the answer",
            quote:
              "Exception: after a workspace exports client archives, the annual subscription is not refundable, even within 30 days.",
          },
        ],
        lesson:
          "The exception carries the answer. A high compression rate is a poor result if this sentence disappears.",
      },
      {
        id: "retention",
        text: "How long can a deleted workspace be restored, and can files be recovered afterward?",
        evidence: [
          {
            label: "Restoration window",
            quote: "Deleted workspaces are held for 14 days before permanent removal.",
          },
          { label: "Recovery limit", quote: "After permanent removal, files cannot be recovered." },
        ],
        lesson:
          "Numbers and limits belong together. Keeping “14 days” alone does not preserve the whole policy.",
      },
    ],
  },
  {
    id: "rag",
    title: "Compress retrieval",
    kind: "RAG",
    origin: "Northstar · incident knowledge base",
    description:
      "Retrieve passages with lexical overlap, then compress only those passages. Watch retrieval and compression lose evidence separately.",
    passages: [
      {
        id: "incident",
        title: "INC-42 incident report",
        body: "Checkout errors began at 14:05 UTC on 18 October 2026, shortly after release v2.8. A connection pool was exhausted under peak traffic. The service returned HTTP 503 for some requests. The team rolled back release v2.8 at 14:22 UTC.\n\nRollback reduced checkout errors, but did not clear existing stuck connections. Restarting the checkout workers at 14:31 UTC restored normal checkout traffic. The customer impact lasted 26 minutes. No orders were lost; failed payments were not captured.",
      },
      {
        id: "runbook",
        title: "Checkout recovery runbook",
        body: "For checkout HTTP 503 errors, inspect connection pool utilization and worker health first. Page the on-call engineer if pool utilization stays above 90% for five minutes. Capture diagnostic counters before making changes.\n\nDo not restart workers while the migration lock is active. A restart during the lock can interrupt a schema migration. Check the migration dashboard, confirm that the lock is released, then restart workers one group at a time. Record the restart time in the incident channel.",
      },
      {
        id: "old",
        title: "INC-17 historical checkout incident",
        body: "A historical checkout outage on 2 August 2026 was caused by a third-party payment gateway timeout. Increasing the gateway timeout resolved that incident. This report does not describe the October outage.\n\nCustomers saw HTTP 504, rather than HTTP 503. The on-call engineer contacted the payment gateway provider. No release was rolled back and no connection pool exhaustion was observed. Keep this distinction when looking for a recovery procedure.",
      },
      {
        id: "release",
        title: "Release v2.8 notes",
        body: "Release v2.8 added checkout tracing, a new reporting dashboard and a connection pool configuration change. The checkout tracing feature adds a correlation ID to each outgoing request. The release was approved after the staging test suite passed.\n\nThe reporting dashboard contains daily totals, historical comparisons and a CSV export. It uses a separate read replica. The release notes were written before the production incident and do not document the recovery timeline.",
      },
      {
        id: "search",
        title: "Search service operations",
        body: "The search service uses an independent worker pool and does not process checkout payments. Search index refreshes run every fifteen minutes. A stale index may hide a newly published item until the next refresh.\n\nSearch workers can be restarted without affecting the checkout service. Search diagnostics use a separate dashboard. The support team should collect the query string, timestamp and account region when investigating missing search results.",
      },
    ],
    questions: [
      {
        id: "recovery",
        text: "What restored checkout after the October connection pool outage, and when?",
        evidence: [
          {
            label: "Rollback was insufficient",
            quote:
              "Rollback reduced checkout errors, but did not clear existing stuck connections.",
          },
          {
            label: "Action and recovery time",
            quote: "Restarting the checkout workers at 14:31 UTC restored normal checkout traffic.",
          },
        ],
        lesson:
          "Two similar incident reports compete for attention. The right action with the wrong incident date is still wrong.",
      },
      {
        id: "lock",
        text: "When should checkout workers not be restarted, and what must be checked first?",
        evidence: [
          {
            label: "Safety condition",
            quote: "Do not restart workers while the migration lock is active.",
          },
          {
            label: "Required check",
            quote:
              "Check the migration dashboard, confirm that the lock is released, then restart workers one group at a time.",
          },
        ],
        lesson:
          "A negative condition is evidence. Compression that keeps only the action can reverse a runbook's meaning.",
      },
      {
        id: "cross-source",
        text: "How was the October checkout outage restored, and what migration lock condition applies to restarting workers?",
        evidence: [
          {
            label: "Measured recovery action",
            quote: "Restarting the checkout workers at 14:31 UTC restored normal checkout traffic.",
          },
          {
            label: "Runbook safety condition",
            quote: "Do not restart workers while the migration lock is active.",
          },
        ],
        lesson:
          "This question needs two sources. At top-k = 1, retrieval already loses evidence before compression starts.",
      },
    ],
  },
  {
    id: "agent",
    title: "Trim a tool result",
    kind: "Agent tool output",
    origin: "read_timeline · captured synthetic result",
    description:
      "One captured timeline, two reading intents. Add the focus of the read to the question before scoring.",
    passages: [
      {
        id: "p1",
        title: "Post 01 · @mira · 09:10",
        body: "The new Northstar dashboard looks polished. I like the navigation and the darker sidebar. Our team has been testing the preview for two weeks, mostly on laptops. Keyboard shortcuts still need some work.",
      },
      {
        id: "p2",
        title: "Post 02 · @northstar · 09:20",
        body: "Northstar's public launch is scheduled for 6 November 2026. The launch webinar starts at 16:00 UTC. Preview users will receive an invitation by email. The recording will be available the following day.",
      },
      {
        id: "p3",
        title: "Post 03 · @devon · 09:35",
        body: "Pricing feedback: the new $39 seat price is too high for our volunteer group. We previously paid $19 per seat. We need either a nonprofit discount or a smaller plan; adding more features does not solve the budget problem.",
      },
      {
        id: "p4",
        title: "Post 04 · @lee · 09:45",
        body: "Made a small illustration of the Northstar logo in a notebook. The new color palette reminds me of our old office. Looking forward to seeing what the community builds with it over the next year.",
      },
      {
        id: "p5",
        title: "Post 05 · @northstar · 10:00",
        body: "Correction to the launch announcement: the public launch moves to 13 November 2026. The webinar remains at 16:00 UTC on the new date. The older 6 November date should no longer be used. We need one more week for accessibility testing.",
      },
      {
        id: "p6",
        title: "Post 06 · @sana · 10:15",
        body: "Pricing feedback: annual prepayment is a barrier for our seasonal team. Please keep monthly billing available. Our concern is the payment schedule, not the seat price. We only need the tool during three months of the year.",
      },
      {
        id: "p7",
        title: "Post 07 · @oscar · 10:30",
        body: "I used Northstar to organize a weekend hiking trip. Shared a checklist and a route map with friends. Offline mode would be useful in the mountains, especially when mobile coverage is unreliable. Everyone liked the simple project view.",
      },
      {
        id: "p8",
        title: "Post 08 · @northstar · 10:45",
        body: "We are collecting feedback through the support form. Include your workspace name and the feature you tried. The team reads every submission, though we cannot promise an individual response to every message. Thanks for helping improve the preview.",
      },
    ],
    questions: [
      {
        id: "pricing",
        text: "What should the Northstar team follow up on from this timeline?",
        focus: "Find pricing complaints about seat price and monthly billing.",
        evidence: [
          {
            label: "Seat-price complaint",
            quote: "Pricing feedback: the new $39 seat price is too high for our volunteer group.",
          },
          {
            label: "Billing-schedule complaint",
            quote: "Pricing feedback: annual prepayment is a barrier for our seasonal team.",
          },
          { label: "Requested billing option", quote: "Please keep monthly billing available." },
        ],
        lesson:
          "The broad task is not enough. A read-specific focus points selection toward the two distinct pricing complaints.",
      },
      {
        id: "launch",
        text: "What should the Northstar team follow up on from this timeline?",
        focus: "Find the corrected public launch date and webinar time.",
        evidence: [
          {
            label: "Corrected launch date",
            quote:
              "Correction to the launch announcement: the public launch moves to 13 November 2026.",
          },
          { label: "Webinar time", quote: "The webinar remains at 16:00 UTC on the new date." },
          {
            label: "Superseded announcement",
            quote: "The older 6 November date should no longer be used.",
          },
        ],
        lesson:
          "Same question, same timeline, different focus. Keep the correction with the date it replaces.",
      },
    ],
  },
];

export function retrieve(
  passages: Passage[],
  query: string,
  k: number,
): { passage: Passage; score: number }[] {
  const queryTerms = terms(query);
  return passages
    .map((passage) => {
      const words = terms(`${passage.title} ${passage.body}`);
      return { passage, score: queryTerms.filter((t) => words.includes(t)).length };
    })
    .sort((a, b) => b.score - a.score || passages.indexOf(a.passage) - passages.indexOf(b.passage))
    .slice(0, Math.max(0, Math.floor(k)));
}
export const formatPassages = (passages: Passage[]): string =>
  passages.map((p) => `## ${p.title} [${p.id}]\n\n${p.body}`).join("\n\n");
