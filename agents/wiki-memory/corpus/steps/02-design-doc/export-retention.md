---
type: concept
summary: How long finished export files are kept before deletion.
sources: [src-kickoff, src-design-doc]
updated: 2026-03-16
---
# Export retention

Finished export files from [[ledger-export]] are deleted after a fixed period ([[src-kickoff]]). A lifecycle rule on the exports-prod bucket does the deleting ([[src-design-doc]]).

The signed download link expires sooner than the file. A customer can ask for a new link while the file still exists ([[src-design-doc]]).

## Claims
- `export.retention`: 30 days (as of 2026-03-16, [[src-design-doc]])
- `export.link-expiry`: 7 days (as of 2026-03-16, [[src-design-doc]])
