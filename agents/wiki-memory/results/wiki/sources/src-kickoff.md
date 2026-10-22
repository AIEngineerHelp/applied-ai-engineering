---
type: source
summary: Kickoff notes that set up Ledger Export, a self-serve invoice export.
sources: []
updated: 2026-03-02
---
# Source: Ledger Export kickoff (2 March 2026)

Raw file: `raw/2026-03-02-kickoff-notes.md`

## Key points
- Support exports invoices by hand, about 40 tickets a week. This is why [[ledger-export]] exists.
- Exports run as a nightly batch job on the Postgres read replica.
- Finished files are kept for 30 days ([[export-retention]]).
- Invoice totals come from the [[billing-api]], owned by the Payments team.
- [[amara-osei]] owns the project; [[rui-costa]] owns the customer-facing copy.

## Open questions
- The request rate the job may use against the Billing API.
