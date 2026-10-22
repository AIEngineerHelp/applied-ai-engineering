---
type: concept
summary: How Ledger Export stays within limits set by other teams' APIs.
sources: [src-inc-482]
updated: 2026-04-07
---
# API rate limits

A limit set by another team can change without the caller noticing. [[inc-482]] happened because the [[billing-api]] limit was halved while [[ledger-export]] kept its old rate ([[src-inc-482]]).

- Leave headroom below the limit and back off on HTTP 429.
- The owning team announces changes in advance: the [[payments-team]] posts in #payments-changes at least a week ahead.
- Alert on the outcome (the run finished by 06:00 UTC), not only on errors.
