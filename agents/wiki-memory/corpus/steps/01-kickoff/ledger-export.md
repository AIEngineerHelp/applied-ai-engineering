---
type: entity
summary: The self-serve invoice CSV export project.
sources: [src-kickoff]
updated: 2026-03-02
---
# Ledger Export

A customer picks a date range and receives one CSV of their invoices. It replaces manual exports by support, about 40 tickets a week ([[src-kickoff]]).

- Owner: [[amara-osei]]. Customer-facing copy: [[rui-costa]].
- Runs as a nightly batch job on the Postgres read replica.
- Reads invoice totals from the [[billing-api]].
- How long files are kept: [[export-retention]].

## Claims
- `export.schedule`: nightly (as of 2026-03-02, [[src-kickoff]])
