# Wiki schema

This file tells the agent how to maintain the wiki. In a real setup it would sit in the agent's instruction file (for example `AGENTS.md` or `CLAUDE.md`). Every page in `corpus/steps/` follows it, and `src/lint.ts` checks the rules that code can check.

## Layers

- `raw/` holds the sources. They are never edited.
- `wiki/` holds the pages. The agent writes every page.
- `wiki/index.md` lists every page with a one-line summary. It is rebuilt after each change.
- `wiki/log.md` is append-only. Each entry starts with `## [YYYY-MM-DD] <ingest|lint|query> | <title>`.

## Page types and folders

| Type | Folder | One page per |
| --- | --- | --- |
| `overview` | `wiki/` | The wiki as a whole: current state and open questions |
| `source` | `wiki/sources/` | Raw source, named `src-<slug>` |
| `entity` | `wiki/entities/` | Person, team, system, project or incident |
| `concept` | `wiki/concepts/` | Idea or policy that spans several entities |

## Page format

Each page starts with front matter:

```text
---
type: entity
summary: One line, used in the index.
sources: [src-kickoff, src-design-doc]
updated: 2026-03-16
---
```

Link other pages with `[[slug]]`. Cite a source page after each fact.

## Claims

Facts that can change or conflict go in a `## Claims` section, one per line:

```text
- `export.retention.standard`: 30 days (as of 2026-04-20, [[src-support-thread]])
```

- A claim lives on the page of the topic it describes, not on source pages.
- When a source **explicitly** replaces a value ("lowered from 100 to 50"), strike the old claim through and add the new one: `- ~~...~~ superseded by [[src-x]]`.
- When a source states a different value **without** saying it replaces the old one, add it as a second claim and do not choose between them. Lint flags the pair for a decision.
- A claim struck through as `disputed` stays in the page as a record, but is no longer current.

## Ingest

1. Write a source page that summarizes the raw source and links every page it touches.
2. Update the entity and concept pages the source is about, and their claims.
3. Update the overview.
4. Rebuild the index and append one log entry.

## Lint

Check for: contradicting claims, links to pages that don't exist, pages nothing links to, and claims without a cited source. Propose fixes; a person approves any fix that picks between two sources.
