import { Tiktoken } from "js-tiktoken/lite";
import ranks from "js-tiktoken/ranks/cl100k_base";

const encoder = new Tiktoken(ranks);
// Encode arbitrary source literally, including strings that resemble special tokens.
export const countTokens = (text: string): number => encoder.encode(text, [], []).length;
