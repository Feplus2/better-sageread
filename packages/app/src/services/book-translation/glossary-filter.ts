export function sanitizeGlossaryItems<T extends { src: string }>(items: T[]): T[] {
  return items.filter((item) => {
    const src = item.src.trim();
    return src.length > 0 && !/[$\\]/.test(src);
  });
}
