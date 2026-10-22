---
type: source
summary: Approved pipeline design: schedule, data flow, Billing API limits and retention.
sources: []
updated: 2026-03-16
---
# Source: Ledger Export pipeline design (16 March 2026)

Raw file: `raw/2026-03-16-design-doc.md`. Author: [[amara-osei]]. Status: approved.

## Key points
- [[ledger-export]] runs nightly at 02:00 UTC; requests made during the day wait for that run.
- Each invoice total comes from the [[billing-api]]. [[jun-park]] of the [[payments-team]] confirmed a limit of 100 requests per second per client; the job will use 80.
- A lifecycle rule on the exports-prod bucket deletes files after 30 days. Signed download links expire after 7 days ([[export-retention]]).
- Risk: a slow Billing API could push the run past 06:00 UTC.
