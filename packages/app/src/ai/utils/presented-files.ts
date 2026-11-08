export interface PresentedFile {
  path: string;
  description?: string;
}

interface MessageLike {
  id: string;
  parts: Array<Record<string, any>>;
}

function effectiveToolName(part: Record<string, any>): string {
  if (part.type === "tool-useTool") return typeof part.input?.tool === "string" ? part.input.tool : "";
  if (part.type === "dynamic-tool") return typeof part.toolName === "string" ? part.toolName : "";
  return typeof part.type === "string" && part.type.startsWith("tool-") ? part.type.slice(5) : "";
}

function pathKey(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return /^(?:[A-Za-z]:\/|\/\/)/.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function collectPresentedFiles(message: MessageLike): PresentedFile[] {
  const files = new Map<string, PresentedFile>();
  for (const part of message.parts) {
    if (effectiveToolName(part) !== "present" || part.state !== "output-available") continue;
    const deliverable = part.output?.results?.success === true ? part.output.results.deliverable : undefined;
    if (typeof deliverable?.path !== "string" || !deliverable.path.trim()) continue;
    const key = pathKey(deliverable.path);
    if (files.has(key)) continue;
    files.set(key, {
      path: deliverable.path,
      ...(typeof deliverable.description === "string" && deliverable.description.trim()
        ? { description: deliverable.description.trim() }
        : {}),
    });
  }
  return Array.from(files.values());
}
