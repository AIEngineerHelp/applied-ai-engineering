// Rough token estimates for the playground.
//
// Every provider uses its own tokenizer, so exact counts need the provider's
// count-tokens endpoint. For English prose and JSON, about four characters per
// token is close enough to reason about cache boundaries and costs. The live
// experiment reports the provider's real counts.

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function charsToTokens(chars) {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
