export type FileLinkClassification =
  | { kind: "local"; path: string; absolute: boolean }
  | { kind: "external" | "other" | "blocked" };

function decodePath(value: string): FileLinkClassification {
  let path = value;
  try {
    path = decodeURIComponent(value);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
  }
  const hasControlCharacter = Array.from(path).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!path || hasControlCharacter) return { kind: "blocked" };
  return {
    kind: "local",
    path,
    absolute: /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(path),
  };
}

export function classifyFileLink(href: string | undefined): FileLinkClassification {
  const value = href?.trim() ?? "";
  if (!value) return { kind: "other" };
  if (/^https?:\/\//i.test(value)) return { kind: "external" };
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol !== "file:") return { kind: "blocked" };
      if (/^[a-z]$/i.test(url.hostname)) return decodePath(`${url.hostname.toUpperCase()}:${url.pathname}`);
      if (url.hostname && url.hostname !== "localhost") return decodePath(`//${url.hostname}${url.pathname}`);
      const path = url.pathname;
      return decodePath(/^\/[a-z]:[\\/]/i.test(path) ? path.slice(1) : path);
    } catch {
      return { kind: "blocked" };
    }
  }
  if (/^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\")) return decodePath(value);
  if (/^(?:mailto|tel):/i.test(value)) return { kind: "other" };
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return { kind: "blocked" };
  if (value.startsWith("#") || value.startsWith("?") || value.startsWith("//")) return { kind: "other" };
  return decodePath(value);
}

export function isLocalPathWithinRoot(root: string, candidate: string): boolean {
  const rootPath = root.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const candidatePath = candidate.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const insensitive = /^(?:[a-z]:|\/\/)/i.test(rootPath);
  const rootKey = insensitive ? rootPath.toLowerCase() : rootPath;
  const candidateKey = insensitive ? candidatePath.toLowerCase() : candidatePath;
  return candidateKey === rootKey || candidateKey.startsWith(rootKey.endsWith("/") ? rootKey : `${rootKey}/`);
}
