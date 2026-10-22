---
type: overview
summary: What this wiki covers and where Ledger Export stands.
sources: [src-kickoff, src-design-doc, src-inc-482, src-support-thread, src-faq-draft]
updated: 2026-05-05
---
# Overview

This wiki tracks [[ledger-export]], a self-serve invoice export, from its kickoff on 2 March 2026.

## Current state
- Live: a nightly run at 02:00 UTC that writes one CSV per request.
- Calls the [[billing-api]] at 40 requests per second, under its limit of 50 since 3 April.
- From 1 May, files are kept for 90 days on Enterprise plans and 30 days on others; download links expire after 7 ([[export-retention]]).

## History
- 4 to 6 April: [[inc-482]], three failed runs after the Billing API limit was halved.

## Open questions
- ~~The Billing API request rate for the export job.~~ Answered by [[src-design-doc]].
- A draft help-centre FAQ arrived on 5 May and is waiting for review by [[rui-costa]] ([[src-faq-draft]]).
