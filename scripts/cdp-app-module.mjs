export function appModuleExpression(path) {
  return `(() => {
    const path = ${JSON.stringify(path)};
    const loaded = performance.getEntriesByType("resource").map((entry) => entry.name).filter((url) => {
      const parsed = new URL(url);
      return parsed.pathname === path;
    }).at(-1);
    return loaded ?? path;
  })()`;
}
