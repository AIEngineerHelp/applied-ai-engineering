// Personal data, found by pattern and replaced before text reaches a model, the
// database or a report. Patterns catch structured identifiers (contacts, record
// and ID numbers, dates of birth); free-text names are not detected.

const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "email", re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  // Medical record numbers and similar labelled identifiers.
  // Linking words are allowed ("my MRN is 4482913", "patient ID: A-1234"); the identifier must contain a digit.
  { kind: "record number", re: /\b(?:MRN|medical record(?: number| no\.?)?|patient (?:id|number)|NHS (?:no\.?|number))(?:\s*(?:is|was|=|:|#|no\.?|number))*\s*(?=[A-Z-]*\d)[A-Z0-9-]{4,}\b/gi },
  { kind: "date of birth", re: /\b(?:DOB|date of birth|born(?: on)?)(?:\s*(?:is|was|=|:|#))*\s*(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Z][a-z]+ \d{1,2},? \d{4})/gi },
  { kind: "ID number", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Phone numbers need real separators (dashes, dots or brackets), so lists of figures are left alone.
  { kind: "phone number", re: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)\s?|\b\d{3}[.-])\d{3}[.-]\d{4}\b/g },
];

/** A Luhn-valid 13–16 digit number in groups (a payment card), so runs of years or counts are not mistaken for one. */
const CARD = /\b\d{4}([ -]?)\d{4}\1\d{4}\1\d{1,4}\b/g;
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

export interface Redaction {
  text: string;
  /** Kinds of personal data removed, e.g. ["email", "record number"]. */
  found: string[];
}

export function redactPII(text: string): Redaction {
  const found = new Set<string>();
  let out = text;
  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, () => {
      found.add(kind);
      return `[${kind} removed]`;
    });
  }
  out = out.replace(CARD, (m) => (luhn(m.replace(/\D/g, "")) ? (found.add("card number"), "[card number removed]") : m));
  return { text: out, found: [...found] };
}

/** The kinds already redacted from a text (its "[… removed]" markers). */
export const redactedKinds = (text: string) => [...new Set([...text.matchAll(/\[([a-z ]+) removed\]/gi)].map((m) => m[1]))];
