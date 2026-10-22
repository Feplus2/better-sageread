import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { exists, readTextFile } from "@tauri-apps/plugin-fs";

/** P1 文档句柄共享层：DocRef 解析、元数据读取、索引探测。 */

export type DocKind = "book" | "paper";

export interface DocRef {
  kind: DocKind;
  id: string;
}

export interface AgentDocScope {
  scope: "reader" | "paper" | "central";
  currentId?: string;
  paperScopeIds?: string[] | null;
}

/** 解析 doc 参数（book:<id> / paper:<id>）；缺省用当前文档。 */
export function resolveDocRef(value: string | undefined, ctx: AgentDocScope): DocRef {
  const raw = (value ?? "").trim();
  if (!raw) {
    if (!ctx.currentId) {
      throw new Error("没有当前文档。请传 doc，例如 doc=paper:<paper_id> 或 doc=book:<book_id>");
    }
    return { kind: ctx.scope === "reader" ? "book" : "paper", id: ctx.currentId };
  }
  const matched = /^(book|paper):([A-Za-z0-9_-]{4,})$/.exec(raw);
  if (!matched) {
    throw new Error(`doc 参数格式应为 book:<id> 或 paper:<id>，收到：${raw}`);
  }
  return { kind: matched[1] as DocKind, id: matched[2] };
}

export function docRefString(doc: DocRef): string {
  return `${doc.kind}:${doc.id}`;
}

export async function docDir(docId: string): Promise<string> {
  return `${await appDataDir()}/books/${docId}`;
}

export interface DocMetadata {
  title?: string;
  author?: string;
  language?: string;
  published?: string;
  doi?: string;
  venue?: string;
  raw: Record<string, unknown> | null;
}

export async function readDocMetadata(doc: DocRef): Promise<DocMetadata> {
  try {
    const metaPath = `${await docDir(doc.id)}/metadata.json`;
    if (!(await exists(metaPath))) return { raw: null };
    const raw = JSON.parse(await readTextFile(metaPath)) as Record<string, unknown>;
    const authorRaw = raw.author;
    const author =
      typeof authorRaw === "string"
        ? authorRaw
        : authorRaw && typeof authorRaw === "object"
          ? String((authorRaw as Record<string, unknown>).name ?? "")
          : "";
    return {
      title: typeof raw.title === "string" ? raw.title : undefined,
      author: author || undefined,
      language: typeof raw.language === "string" ? raw.language : undefined,
      published: typeof raw.published === "string" ? raw.published : undefined,
      doi: typeof raw.doi === "string" ? raw.doi : undefined,
      venue: typeof raw["container-title"] === "string" ? (raw["container-title"] as string) : undefined,
      raw,
    };
  } catch {
    return { raw: null };
  }
}

export async function bookIndexed(docId: string): Promise<boolean> {
  try {
    return await exists(`${await docDir(docId)}/vectors.sqlite`);
  } catch {
    return false;
  }
}

/** 论文是否已建向量索引（全局 papers/vectors.sqlite 中是否有该 paper_id 的分块）。 */
export async function paperIndexed(paperId: string): Promise<boolean> {
  try {
    const status = await invoke<{ indexed: boolean; chunkCount: number }>("plugin:epub|paper_index_status", {
      paperId,
    });
    return status.indexed;
  } catch {
    return false;
  }
}

export function clipSnippet(text: string, maxChars: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}
