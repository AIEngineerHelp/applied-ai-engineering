---
type: source
summary: Draft help-centre FAQ for invoice exports; two answers need correcting.
sources: []
updated: 2026-05-06
---
# Source: help-centre FAQ draft (5 May 2026)

Raw file: `raw/2026-05-05-faq-draft.md`. Written by a contract writer, to be reviewed by [[rui-costa]]. Status: draft.

## Key points
- How to export: Billing, then Invoices, then Export; a CSV arrives by email ([[ledger-export]]).
- Says exports are generated every hour.
- Says an export is kept for 7 days ([[export-retention]]).
- Date ranges of up to 24 months.

## Needs correcting
- "Every hour": exports run nightly at 02:00 UTC ([[src-design-doc]]).
- "Kept for 7 days": files are kept 30 days, or 90 on Enterprise; 7 days is the download link's expiry ([[src-support-thread]]).
