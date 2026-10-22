---
type: entity
summary: Payments-owned API that Ledger Export calls for invoice totals.
sources: [src-kickoff, src-design-doc, src-inc-482]
updated: 2026-04-07
---
# Billing API

Owned by the [[payments-team]]. [[ledger-export]] reads each invoice's final total from it ([[src-kickoff]]). [[jun-park]] confirmed the limit ([[src-design-doc]]).

On 3 April 2026 Payments halved the limit during a database migration and kept it; this caused [[inc-482]]. Limit changes are now announced in #payments-changes at least a week ahead ([[src-inc-482]]).

## Open questions
- ~~What request rate may Ledger Export use? Raised at the kickoff.~~ Answered by [[src-design-doc]].

## Claims
- ~~`billing-api.rate-limit`: 100 requests per second per client (as of 2026-03-16, [[src-design-doc]])~~ superseded by [[src-inc-482]]
- `billing-api.rate-limit`: 50 requests per second per client (as of 2026-04-03, [[src-inc-482]])
