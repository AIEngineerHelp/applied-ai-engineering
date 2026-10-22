---
type: source
summary: Incident report: Billing API limit cut to 50 req/s broke three nightly runs.
sources: []
updated: 2026-04-07
---
# Source: Incident INC-482 report (7 April 2026)

Raw file: `raw/2026-04-07-incident-inc-482.md`. Incident lead: [[amara-osei]].

## Key points
- [[inc-482]]: the nightly [[ledger-export]] run failed on 4, 5 and 6 April; about 210 requests were delayed by up to three days.
- On 3 April the [[payments-team]] lowered the [[billing-api]] limit from 100 to 50 requests per second per client. The job still used 80 and was rejected with HTTP 429.
- Fix: the job now uses 40 requests per second and backs off on HTTP 429. The 50 limit is permanent.
- Follow-ups: limit changes are announced in #payments-changes a week ahead ([[jun-park]] owns this); an alert fires if the run hasn't finished by 06:00 UTC.
- General lesson: [[api-rate-limits]].
