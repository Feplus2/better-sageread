import { readPaperMarkdown } from "@/ai/tools/paper/shared";
import { type RetrievalScope, defaultRetrievalScope } from "@/constants/retrieval-scope";
import { type PaperMetadata, normalizeAuthors, parsePaperMarkdown } from "@/pages/paper-reader/paper-metadata";
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
  /** 用户划定的检索范围；缺省按角色回退（reader=current / paper=library / central=all）。 */
  retrievalScope?: RetrievalScope;
  /** 旧版论文工具 paperSearch 的检索范围（仅 legacy 模式；新原语不使用） */
  paperScopeIds?: string[] | null;
}

/** 越界不是"没搜到"：必须抛给模型一个可复述的明确错误，禁止静默降级。 */
export class RetrievalScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetrievalScopeError";
  }
}

/** 解析本轮生效范围：用户圈定值优先；central 恒为 all。 */
export function resolveRetrievalScope(ctx: AgentDocScope): RetrievalScope {
  if (ctx.scope === "central") return defaultRetrievalScope("central");
  return ctx.retrievalScope ?? defaultRetrievalScope(ctx.scope);
}

export function retrievalScopeLabel(scope: AgentDocScope["scope"], value: RetrievalScope): string {
  if (scope === "central") return "全部（图书馆+论文库）";
  const readerLabels: Record<RetrievalScope, string> = {
    current: "本书",
    library: "图书馆（全部书籍，不含论文）",
    all: "图书馆+论文库",
  };
  const paperLabels: Record<RetrievalScope, string> = {
    current: "本篇论文",
    library: "论文库（全部论文，不含书籍）",
    all: "论文库+图书馆",
  };
  return scope === "reader" ? readerLabels[value] : paperLabels[value];
}

/** 文档是否落在用户圈定范围内（角色决定 kind/current 的边界）。 */
export function isDocInRetrievalScope(doc: DocRef, ctx: AgentDocScope): boolean {
  if (ctx.scope === "central") return true;
  const circle = resolveRetrievalScope(ctx);
  if (ctx.scope === "reader") {
    if (circle === "current") return doc.kind === "book" && doc.id === ctx.currentId;
    if (circle === "library") return doc.kind === "book";
    return doc.kind === "book" || doc.kind === "paper";
  }
  if (circle === "current") return doc.kind === "paper" && doc.id === ctx.currentId;
  if (circle === "library") return doc.kind === "paper";
  return doc.kind === "paper" || doc.kind === "book";
}

/** 直读工具的统一门禁：越界抛 RetrievalScopeError（带"请用户切下拉"的可执行指引）。 */
export function assertDocInRetrievalScope(doc: DocRef, ctx: AgentDocScope): void {
  if (isDocInRetrievalScope(doc, ctx)) return;
  const circle = resolveRetrievalScope(ctx);
  const currentRef = ctx.currentId
    ? `${ctx.scope === "reader" ? "book" : "paper"}:${ctx.currentId}`
    : "（未绑定当前文档）";
  // 引导语要区分"需要更广同类资料库"还是"需要跨到另一类库"，否则指向的下拉档位仍然越界
  const next =
    ctx.scope === "reader"
      ? doc.kind === "paper"
        ? "请让用户把侧栏顶部的检索范围下拉切到「图书馆+论文库」后再试"
        : circle === "current"
          ? "请让用户把侧栏顶部的检索范围下拉切到「图书馆」或「图书馆+论文库」后再试"
          : "请让用户把侧栏顶部的检索范围下拉切到「图书馆+论文库」后再试"
      : doc.kind === "book"
        ? "请让用户把侧栏顶部的检索范围下拉切到「论文库+图书馆」后再试"
        : circle === "current"
          ? "请让用户把侧栏顶部的检索范围下拉切到「论文库」或「论文库+图书馆」后再试"
          : "请让用户把侧栏顶部的检索范围下拉切到「论文库+图书馆」后再试";
  throw new RetrievalScopeError(
    `超出用户划定的检索范围：本轮范围是「${retrievalScopeLabel(ctx.scope, circle)}」，` +
      `${docRefString(doc)} 在圈外（当前文档 ${currentRef}）。` +
      `不要自行扩大范围、改用其它工具或绕路径读取；${next}。`,
  );
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
  authors?: string[];
  language?: string;
  published?: string;
  date?: string;
  abstract?: string;
  keywords?: string[];
  volume?: string;
  issue?: string;
  page?: string;
  doi?: string;
  venue?: string;
  raw: Record<string, unknown> | null;
}

export type DocMetadataErrorHandler = (error: unknown) => void;

function isNotFoundError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (code === "ENOENT") return true;
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("enoent") || message.includes("no such file") || message.includes("os error 2");
}

async function readPaperDocMetadata(docId: string, onError?: DocMetadataErrorHandler): Promise<DocMetadata> {
  let json: Record<string, unknown> = {};
  let frontmatter: PaperMetadata = {};
  try {
    const metaPath = `${await docDir(docId)}/metadata.json`;
    if (await exists(metaPath)) {
      const parsed = JSON.parse(await readTextFile(metaPath)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        json = parsed as Record<string, unknown>;
      } else {
        onError?.(new Error(`metadata.json 必须是对象: ${docId}`));
      }
    }
  } catch (error) {
    if (!isNotFoundError(error)) onError?.(error);
  }
  try {
    frontmatter = parsePaperMarkdown(await readPaperMarkdown(docId)).metadata;
  } catch (error) {
    if (!isNotFoundError(error)) onError?.(error);
  }

  const merged = { ...frontmatter, ...json } as PaperMetadata & Record<string, unknown>;
  return {
    title: merged.title,
    authors: normalizeAuthors(merged.author),
    language: merged.lang,
    published: merged.date,
    date: merged.date,
    abstract: merged.abstract,
    keywords: merged.keywords,
    volume: merged.volume,
    issue: merged.issue,
    page: merged.page,
    doi: merged.doi,
    venue: merged["container-title"],
    raw: Object.keys(merged).length > 0 ? merged : null,
  };
}

export async function readDocMetadata(doc: DocRef, onError?: DocMetadataErrorHandler): Promise<DocMetadata> {
  if (doc.kind === "paper") return readPaperDocMetadata(doc.id, onError);
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
  } catch (error) {
    if (!isNotFoundError(error)) onError?.(error);
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
