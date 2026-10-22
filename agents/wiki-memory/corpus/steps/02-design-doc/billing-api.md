---
type: entity
summary: Payments-owned API that Ledger Export calls for invoice totals.
sources: [src-kickoff, src-design-doc]
updated: 2026-03-16
---
# Billing API

Owned by the [[payments-team]]. [[ledger-export]] reads each invoice's final total from it ([[src-kickoff]]). [[jun-park]] confirmed the limit ([[src-design-doc]]).

## Claims
- `billing-api.rate-limit`: 100 requests per second per client (as of 2026-03-16, [[src-design-doc]])
