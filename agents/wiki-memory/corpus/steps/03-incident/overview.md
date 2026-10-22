---
type: overview
summary: What this wiki covers and where Ledger Export stands.
sources: [src-kickoff, src-design-doc, src-inc-482]
updated: 2026-04-07
---
# Overview

This wiki tracks [[ledger-export]], a self-serve invoice export, from its kickoff on 2 March 2026.

## Current state
- Live: a nightly run at 02:00 UTC that writes one CSV per request.
- Calls the [[billing-api]] at 40 requests per second, under its limit of 50 since 3 April.
- Files are kept for 30 days; download links expire after 7 ([[export-retention]]).

## History
- 4 to 6 April: [[inc-482]], three failed runs after the Billing API limit was halved.

## Open questions
- None.
