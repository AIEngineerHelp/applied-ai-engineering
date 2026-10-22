---
type: overview
summary: What this wiki covers and where Ledger Export stands.
sources: [src-kickoff, src-design-doc]
updated: 2026-03-16
---
# Overview

This wiki tracks [[ledger-export]], a self-serve invoice export, from its kickoff on 2 March 2026.

## Current state
- Design approved on 16 March: a nightly run at 02:00 UTC that writes one CSV per request.
- Calls the [[billing-api]] at 80 requests per second, under its limit of 100.
- Files are kept for 30 days; download links expire after 7 ([[export-retention]]).

## Open questions
- None.
