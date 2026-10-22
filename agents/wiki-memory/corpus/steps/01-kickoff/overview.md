---
type: overview
summary: What this wiki covers and where Ledger Export stands.
sources: [src-kickoff]
updated: 2026-03-02
---
# Overview

This wiki tracks [[ledger-export]], a self-serve invoice export, from its kickoff on 2 March 2026.

## Current state
- Planned as a nightly batch job that writes one CSV per request.
- Depends on the [[billing-api]]. The request rate it may use is not known yet.
- Files are kept for 30 days ([[export-retention]]).

## Open questions
- The Billing API request rate for the export job.
