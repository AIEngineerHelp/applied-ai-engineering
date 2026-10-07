// Rough token estimates. Every model uses its own tokenizer; about four
// characters per token is close enough for English prose, code and CSV to size
// chunks and compare context budgets. All sizes in this example use it.

export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
