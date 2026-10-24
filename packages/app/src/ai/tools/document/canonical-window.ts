export interface CanonicalWindowOptions {
  offset?: number;
  before?: number;
  after: number;
  minStart?: number;
  maxEnd?: number;
}

export interface CanonicalWindow {
  text: string;
  start: number;
  end: number;
  nextOffset: number | null;
  truncated: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function readCanonicalWindow(text: string, options: CanonicalWindowOptions): CanonicalWindow {
  const maxEnd = clamp(options.maxEnd ?? text.length, 0, text.length);
  const minStart = clamp(options.minStart ?? 0, 0, maxEnd);
  const offset = clamp(options.offset ?? minStart, minStart, maxEnd);
  const before = Math.max(options.before ?? 0, 0);
  const start = Math.max(minStart, offset - before);
  const end = Math.min(maxEnd, offset + Math.max(options.after, 0));
  const nextOffset = end < maxEnd ? end : null;
  return {
    text: text.slice(start, end),
    start,
    end,
    nextOffset,
    truncated: nextOffset != null,
  };
}
