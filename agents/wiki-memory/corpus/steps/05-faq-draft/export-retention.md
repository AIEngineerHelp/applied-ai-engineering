---
type: concept
summary: How long finished export files are kept: 90 days on Enterprise, 30 on other plans.
sources: [src-kickoff, src-design-doc, src-support-thread, src-faq-draft]
updated: 2026-05-05
---
# Export retention

Finished export files from [[ledger-export]] are deleted after a fixed period ([[src-kickoff]]). A lifecycle rule on the exports-prod bucket does the deleting ([[src-design-doc]]).

From 1 May 2026 the period depends on the plan: Enterprise files are kept for 90 days and files on all other plans for 30 days. The rule reads a plan tag, so files written before then keep their old date ([[src-support-thread]]).

The signed download link expires sooner than the file. A customer can ask for a new link while the file still exists ([[src-design-doc]]).

## Claims
- ~~`export.retention`: 30 days (as of 2026-03-16, [[src-design-doc]])~~ superseded by [[src-support-thread]]
- `export.retention.standard`: 30 days (as of 2026-05-01, [[src-support-thread]])
- `export.retention.enterprise`: 90 days (as of 2026-05-01, [[src-support-thread]])
- `export.link-expiry`: 7 days (as of 2026-03-16, [[src-design-doc]])
- `export.retention`: 7 days (as of 2026-05-05, [[src-faq-draft]])
