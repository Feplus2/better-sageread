export type ChangedFileSource = "writeFile" | "editFile" | "runCommand";
export type ChangedFileKind = "changed" | "created" | "modified" | "deleted";

export interface ChangedFile {
  path: string;
  source: ChangedFileSource;
  toolCallId: string;
  messageId: string;
  kind: ChangedFileKind;
  verified: boolean;
  operationCount: number;
  bytes?: number;
  replacements?: number;
  created?: boolean;
}

interface MessageLike {
  id: string;
  parts: Array<Record<string, any>>;
}

const WRITE_TOOLS = new Set(["writeFile", "editFile"]);

function effectiveToolName(part: Record<string, any>): string {
  if (part.type === "tool-useTool") return typeof part.input?.tool === "string" ? part.input.tool : "";
  if (part.type === "dynamic-tool") return typeof part.toolName === "string" ? part.toolName : "";
  return typeof part.type === "string" && part.type.startsWith("tool-") ? part.type.slice(5) : "";
}

function pathKey(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return /^(?:[A-Za-z]:\/|\/\/)/.test(normalized) ? normalized.toLowerCase() : normalized;
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function appendFile(files: Map<string, ChangedFile>, item: Omit<ChangedFile, "operationCount">) {
  const key = pathKey(item.path);
  const previous = files.get(key);
  const created =
    item.kind === "deleted"
      ? false
      : item.created === true || previous?.created === true
        ? true
        : (item.created ?? previous?.created);
  files.set(key, {
    ...item,
    ...(created === undefined ? {} : { created }),
    operationCount: (previous?.operationCount ?? 0) + 1,
  });
}

export function collectChangedFiles(messages: MessageLike[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.state !== "output-available") continue;
      const name = effectiveToolName(part);
      const results = part.output?.results;
      const base = {
        toolCallId: String(part.toolCallId ?? ""),
        messageId: message.id,
        verified: true as const,
      };
      let next: Omit<ChangedFile, "operationCount"> | null = null;
      if (WRITE_TOOLS.has(name) && results?.success === true && validPath(results.path)) {
        next = {
          ...base,
          path: results.path,
          source: name as ChangedFileSource,
          kind: "changed",
          ...(typeof results.created === "boolean" ? { created: results.created } : {}),
          ...(typeof results.bytes === "number" ? { bytes: results.bytes } : {}),
          ...(typeof results.replacements === "number" ? { replacements: results.replacements } : {}),
        };
      } else if (name === "runCommand" && Array.isArray(results?.changes)) {
        for (const change of results.changes) {
          if (change?.verified !== true || !validPath(change.path)) continue;
          if (!["created", "modified", "deleted"].includes(change.kind)) continue;
          appendFile(files, {
            ...base,
            path: change.path,
            source: "runCommand",
            kind: change.kind,
            created: change.kind === "created",
          });
        }
        continue;
      }
      if (!next) continue;
      appendFile(files, next);
    }
  }
  return Array.from(files.values());
}
