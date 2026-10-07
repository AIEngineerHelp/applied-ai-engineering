// Shared types for the chunking engine and the app.

/** A [start, end) character range in a source document. */
export type Range = [number, number];

export type Format = "markdown" | "code" | "table" | "contract" | "transcript" | "figures" | "slides";

export interface Doc {
  id: string;
  title: string;
  format: Format;
  text: string;
  /** Image descriptions, as a vision-language model would write them for retrieval. */
  images?: ImageMeta[];
}

export interface ImageMeta {
  /** Path as written in the document, e.g. "figures/net-ontime.svg". */
  file: string;
  number?: number;
  slide?: number;
  description: string;
}

export interface Chunk {
  docId: string;
  /** Source ranges: attached headings first, then the chunk's own text (last). */
  spans: Range[];
  /** What gets embedded and returned to the model. */
  text: string;
  /** Section path, for display. */
  label?: string;
  /** The image this chunk carries, if any. */
  image?: { file: string; alt: string; number?: number; description?: string };
  /** Other chunks returned together with this one (a figure and the text that cites it). */
  links?: number[];
  /** Why each link exists, in the same order as `links`. */
  linkReasons?: string[];
}
