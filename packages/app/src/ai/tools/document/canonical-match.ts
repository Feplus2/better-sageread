export interface CanonicalMatch {
  offset: number | null;
  anchor_precision: "exact" | "section";
}

interface NormalizedCanonical {
  text: string;
  originalIndices: number[];
}

const WHITESPACE = /\s/u;

function normalizeWithOriginalIndices(input: string): NormalizedCanonical {
  let text = "";
  const originalIndices: number[] = [];
  let pendingSpace: number | null = null;
  for (let index = 0; index < input.length; index += 1) {
    if (WHITESPACE.test(input[index])) {
      if (text.length > 0 && pendingSpace == null) pendingSpace = index;
      continue;
    }
    if (pendingSpace != null) {
      text += " ";
      originalIndices.push(pendingSpace);
      pendingSpace = null;
    }
    text += input[index];
    originalIndices.push(index);
  }
  return { text, originalIndices };
}

function sectionMatch(): CanonicalMatch {
  return { offset: null, anchor_precision: "section" };
}

export function findCanonicalMatch(canonical: string, snippet: string): CanonicalMatch {
  const trimmed = snippet.trimEnd();
  const unclipped = trimmed.endsWith("…") ? trimmed.slice(0, -1) : trimmed;
  const needle = normalizeWithOriginalIndices(unclipped).text;
  if (!needle) return sectionMatch();

  const normalized = normalizeWithOriginalIndices(canonical);
  const matchIndex = normalized.text.indexOf(needle);
  if (matchIndex < 0 || normalized.text.indexOf(needle, matchIndex + 1) >= 0) return sectionMatch();

  const lastIndex = matchIndex + needle.length - 1;
  const offset = normalized.originalIndices[matchIndex];
  const lastOriginalIndex = normalized.originalIndices[lastIndex];
  if (offset == null || lastOriginalIndex == null) return sectionMatch();

  const original = canonical.slice(offset, lastOriginalIndex + 1);
  if (normalizeWithOriginalIndices(original).text !== needle) return sectionMatch();
  return { offset, anchor_precision: "exact" };
}
