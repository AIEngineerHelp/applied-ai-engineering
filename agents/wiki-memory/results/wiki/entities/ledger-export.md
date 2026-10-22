---
type: entity
summary: The self-serve invoice CSV export project.
sources: [src-kickoff, src-design-doc, src-inc-482, src-faq-draft]
updated: 2026-05-06
---
# Ledger Export

A customer picks a date range and receives one CSV of their invoices. It replaces manual exports by support, about 40 tickets a week ([[src-kickoff]]).

- Owner: [[amara-osei]]. Customer-facing copy: [[rui-costa]].
- Runs as a nightly batch job on the Postgres read replica.
- Reads invoice totals from the [[billing-api]], backing off on HTTP 429 ([[src-inc-482]]).
- Writes one CSV per request to the exports-prod bucket and emails a signed link ([[src-design-doc]]).
- How long files are kept: [[export-retention]].
- Alerts if the run hasn't finished by 06:00 UTC ([[src-inc-482]]).
- Customers can export up to 24 months at a time ([[src-faq-draft]]).
- Past incidents: [[inc-482]].

## Claims
- `export.schedule`: nightly at 02:00 UTC (as of 2026-03-16, [[src-design-doc]])
- ~~`export.billing-api-rate`: 80 requests per second (as of 2026-03-16, [[src-design-doc]])~~ superseded by [[src-inc-482]]
- `export.billing-api-rate`: 40 requests per second (as of 2026-04-07, [[src-inc-482]])
- ~~`export.schedule`: every hour (as of 2026-05-05, [[src-faq-draft]])~~ disputed: an unreviewed draft; conflicts with [[src-design-doc]]
