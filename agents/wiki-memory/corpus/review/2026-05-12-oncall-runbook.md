# On-call runbook: Ledger Export

Owner: Amara Osei (engineering). 12 May 2026.

## Limits

- Each export request covers at most 12 months of invoices, to keep the nightly run under its 06:00 UTC deadline.
- Requests for longer ranges should be split into 12-month parts.
