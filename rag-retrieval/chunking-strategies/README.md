# Chunking by document type

Before a RAG system can retrieve anything, it splits documents into chunks. The right place to cut depends on the document: a FAQ splits at each question, code at each function, a table between rows, a contract at each clause. This example is a small web app. Pick a document type, including documents with charts, slides and parts diagrams, and it highlights exactly how that document is chunked:

- **Where we cut, what we keep together, and what we attach.** Each type shows its rules in plain words, and why they matter.
- **A preview of the real document** with every chunk highlighted on it, one color per chunk: Markdown rendered as formatted text, the CSV as a table, code with syntax highlighting and line numbers, the contract and transcript laid out as documents. A **Source** tab shows the raw file with the same highlights.
- **Click any chunk** to see exactly what gets embedded and returned to the model, with the context we attach (document title, section headings, class name or table header) outlined in the document.
- **A fixed-size split for comparison,** with red marks wherever a cut lands inside a sentence or line.
- **A size slider** (100–800 tokens) to see how the limit changes the result.

It runs entirely in the browser, with no API keys. **Live:** [chunking-strategies-blond.vercel.app](https://chunking-strategies-blond.vercel.app).

## Run it

Requires Node.js 22.12 or later. From `rag-retrieval/chunking-strategies/`:

```bash
npm ci
npm start        # builds the app and serves it on http://127.0.0.1:4322 (PORT and HOST to change)
npm test         # parsers, both chunking methods, and the sample documents
npm run check    # TypeScript type check
npm run export   # static copy in dist/ for deployment
```

Open a view directly with URL parameters: `?type=` (a document id from `corpus/manifest.json`), `&method=fixed` for the fixed-size split, and `&view=source` for the raw file. For example, `http://127.0.0.1:4322/?type=rate-engine&method=fixed`.

## How each type is chunked

| Document | Split at | Keep together | Attach to every chunk |
|---|---|---|---|
| Developer docs (Markdown) | Every heading; long sections at paragraphs | A heading with its text; a heading with no text joins the next section | Title and heading path |
| FAQ (Markdown) | Every question heading | The question and its whole answer | Category heading |
| Research report (Markdown) | Section headings; long sections at paragraph breaks | Whole paragraphs | Title and section heading |
| Source code (Python) | Each top-level function and class; large classes per method | A function with its decorators, docstring and comments; small constants join the next block | File name and class line |
| Table (CSV) | Between rows, packing whole rows up to the limit | Every row | Title and header row |
| Contract | Each numbered clause | The whole clause | Title and article heading |
| Meeting transcript | Between speaker turns, packing turns up to the limit | Every speaker turn | Title |
| Report with charts | Headings; each figure (image + caption) is its own chunk | An image with its caption | To the figure: section path, image description, and every sentence that cites it. Citing text links back to the figure |
| Slide deck | Every slide | Title, bullets, image and speaker notes | Deck title and image description; "previous slide" references link the two slides |
| Manual with diagrams | Headings; each figure is its own chunk; the parts table stays whole | An image with its caption; a procedure's steps | Steps that use callout numbers like "(4)" link to the parts diagram and the parts table |

A unit longer than the limit is split recursively: at blank lines, then line breaks, then sentence ends, then spaces. Sizes are estimated at four characters per token.

The parsers in `src/structure.ts` work from line patterns, which suits these documents. In production, use real parsers (a Markdown AST, tree-sitter for code) and handle PDF and HTML.

## Documents with images

A PDF or slide parser (Docling, Unstructured, LlamaParse, Azure Document Intelligence, Google Layout Parser) turns each picture into an image file with its caption. The three figure documents here are Markdown in that shape: `![alt](figures/x.svg)` followed by `*Figure N. Caption.*`, with `## Slide N: Title` and `> Notes:` for slides. `src/figures.ts` finds each figure and every sentence that refers to it:

- **explicit**: "Figure 2", "Fig. 2"
- **nearby**: "the chart below" (next figure), "the diagram above" (previous figure)
- **slide**: "the diagram on the previous slide"
- **callout**: "(4)" in a step, pointing at a numbered callout in a diagram whose description names callouts

A figure chunk embeds its caption, section path, the image description and the citing sentences. Both sides of each reference get a link, so retrieving either chunk returns the other, and the original image travels with the chunk for a multimodal model at answer time. The image descriptions in `corpus/figures/*.json` were written for this example to stand in for a vision model's output.

The app's "How production systems handle images" panel summarizes the three approaches in use, with sources checked on 2026-10-07:
1. **Describe the image and embed the text**, as Unstructured, Docling, Azure AI Search, Bedrock Data Automation, Google Layout Parser and Databricks do.
2. **Embed the image directly** with a multimodal embedding model: Gemini Embedding 2, Voyage multimodal-3.5, Cohere Embed or Amazon Nova.
3. **Embed whole pages** with ColPali-style late interaction. In the [ColPali paper](https://arxiv.org/abs/2407.01449) this scored nDCG@5 81.3 on ViDoRe, against 67.0 for a parse-and-caption pipeline.

We found no platform that documents resolving "see Figure 3" to a figure elsewhere in the document. The reference matching here is a simple, explicit step you can add after any parser.

## Deployment

The app is a static site on Vercel at [chunking-strategies-blond.vercel.app](https://chunking-strategies-blond.vercel.app), in the project `exclusive1s-projects/chunking-strategies`. It makes no API calls, so serving it costs nothing beyond hosting. To redeploy, run `npm run export`, then `vercel deploy --prod` from `dist/`. The export keeps `dist/.vercel`, the local project link.

## Layout

```text
corpus/          ten synthetic sample documents, manifest.json, and figures/ (SVG images and their descriptions)
src/
  structure.ts     format detection and parsers for Markdown, code, CSV, contracts, transcripts, figure documents and slides
  figures.ts       figure blocks and the sentences that refer to them
  chunkers.ts      structure-aware chunking with context, and fixed-size chunking
  text.ts, tokens.ts, types.ts
client/
  app.ts           the app: document types, the chunk inspector, the source view
  preview.ts       renders each format as it looks, with chunk tints, context outlines and cut marks
  styles.css       Tailwind CSS entry (theme tokens, dark mode, chunk tints)
site/index.html  the page (Tailwind utility classes)
scripts/         local server and static export
tests/           node --test suite
```

The browser code is bundled with esbuild, and the stylesheet is built with the Tailwind CSS CLI into the Git-ignored `site/build/`.

## Sample documents

All ten describe one fictional logistics company, Tidewater Freight, and were written for this example: API docs, a help-center FAQ, a research report, a Python rate engine, a service catalog CSV, a master services agreement, a post-incident review transcript, a quarterly report with four charts, an eight-slide launch deck, and a scanner service manual with an exploded-parts diagram.

## Further reading

- Anthropic, [Introducing Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval): attaching context to each chunk, written by an LLM.
- Brandon Smith and Anton Troynikov, [Evaluating Chunking Strategies for Retrieval](https://research.trychroma.com/evaluating-chunking), Chroma, 2024.
- LangChain, [Text splitters](https://docs.langchain.com/oss/python/integrations/splitters/index).

Discuss it in the [RAG & Retrieval](https://aiengineer.help/c/rag-retrieval/6) community category.
