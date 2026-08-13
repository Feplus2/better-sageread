import { footnoteTransformer } from "./footnote";
import { punctuationTransformer } from "./punctuation";
import { rawmathTransformer } from "./rawmath";
import type { Transformer } from "./types";

export const availableTransformers: Transformer[] = [
  rawmathTransformer,
  punctuationTransformer,
  footnoteTransformer,
  // Add more transformers here
];
