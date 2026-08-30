import { footnoteTransformer } from "./footnote";
import { punctuationTransformer } from "./punctuation";
import { rawmathTransformer } from "./rawmath";
import { translationTransformer } from "./translation";
import type { Transformer } from "./types";

export const availableTransformers: Transformer[] = [
  rawmathTransformer,
  punctuationTransformer,
  footnoteTransformer,
  translationTransformer,
  // Add more transformers here
];
