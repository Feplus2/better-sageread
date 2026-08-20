/**
 * 论文参考文献条目（references.json，Papers_Converter P2.1 产物）的运行时增强：
 * 元数据懒补全（Crossref/OpenAlex）+ 本地库在库检查 + 落地页/Scholar 兜底链接。
 * 补全结果由调用方写回 references.json 缓存（同一篇不重复请求）；
 * 网络栈复用 utils/fetch（CSP connect-src 已放行 https:），不新增依赖。
 */
import { listPapers } from "@/services/paper-service";
import { fetchWithTimeout } from "@/utils/fetch";
import { appDataDir, join } from "@tauri-apps/api/path";
import { readTextFile } from "@tauri-apps/plugin-fs";

/** references.json 条目契约（P2.1）：n 与 paper.md 的 #ref-N 锚点编号一致 */
export interface PaperReference {
  n: number;
  raw: string;
  title?: string;
  authors?: string[];
  year?: string;
  venue?: string;
  doi?: string;
  /** arXiv 编号（如 2404.13213；Zotero Brain download_paper 的直取参数之一） */
  arxiv_id?: string;
  /** P2.2 元数据补全缓存（阅读器写回；undefined = 尚未补全） */
  enrichment?: ReferenceEnrichment;
}

/** 元数据补全结果（只缓存成功结果；失败不落盘，下次开卡重试） */
export interface ReferenceEnrichment {
  source: "crossref" | "openalex" | "semanticscholar";
  title?: string;
  authors?: string[];
  year?: string;
  venue?: string;
  doi?: string;
  abstract?: string;
  landingPage?: string;
  fetchedAt: number;
}

/** 解析后的 references.json 文档 */
export interface PaperReferencesDoc {
  entries: PaperReference[];
  /** 原始文档为对象包装形态（{version, source, count, references}）时的原文档引用，写回时保留外层字段 */
  wrapper: Record<string, any> | null;
}

/**
 * 解析 references.json；文件缺失/结构非法返回 null（旧论文无产物，一切照旧）。
 * 兼容两种形态：裸数组（早期契约）与对象包装 {version, source, count, references}（转换器实际产出）。
 */
export function parseReferencesJson(raw: string): PaperReferencesDoc | null {
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.references) ? parsed.references : null;
    if (!Array.isArray(list)) return null;
    const valid = list.filter((e): e is PaperReference => typeof e?.n === "number" && typeof e?.raw === "string");
    if (valid.length === 0) return null;
    return { entries: valid, wrapper: Array.isArray(parsed) ? null : parsed };
  } catch {
    return null;
  }
}

/** 序列化回 references.json：包装形态保留外层字段并同步 count，裸数组原样写回 */
export function serializeReferences(entries: PaperReference[], wrapper: Record<string, any> | null): string {
  const doc = wrapper ? { ...wrapper, references: entries, count: entries.length } : entries;
  return JSON.stringify(doc, null, 2);
}

/** 标题归一化（在库模糊匹配 / OpenAlex 候选比对共用）：小写、去非字母数字、折叠空白 */
export function normalizePaperTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim();
}

/**
 * 归一化后的词级 Dice 相似度（0~1）：2·|交集|/(|A|+|B|)。
 * 对标题差异形态（前导冠词 The/A、词序、标点）比编辑距离稳健——
 * 实测 OpenAlex 记录会丢前导 "The"（"The number of cosmic string loops" ↔ "Number of cosmic string loops"，
 * 编辑距离比 0.886 被 0.9 阈值误杀，Dice 0.909 通过）。
 */
export function titleSimilarity(a: string, b: string): number {
  const x = normalizePaperTitle(a);
  const y = normalizePaperTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const wx = new Set(x.split(" "));
  const wy = new Set(y.split(" "));
  const intersection = [...wx].filter((w) => wy.has(w)).length;
  return (2 * intersection) / (wx.size + wy.size);
}

/** OpenAlex abstract_inverted_index（词 → 位置表）重建纯文本摘要 */
function rebuildAbstract(index: Record<string, number[]> | null | undefined): string | undefined {
  if (!index) return undefined;
  const positions: string[] = [];
  for (const [word, idxs] of Object.entries(index)) {
    for (const i of idxs) positions[i] = word;
  }
  const text = positions.filter(Boolean).join(" ").trim();
  return text || undefined;
}

/** Crossref 摘要是 JATS XML 片段，去标签取纯文本 */
function stripXml(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 429/5xx 退避重试（Semantic Scholar 未认证限流 ~1 req/s，实测连点卡片大量 429）：
 *  Retry-After 头优先，缺失按 2s/5s 递增，至多重试 2 次；
 *  网络层错误（代理/GFW 间歇断连，实测同样高发）也按同表退避重试。
 *  补全本是开卡后的异步路径，退避等待不阻塞卡片展示。 */
async function fetchWithBackoff(url: string): Promise<Response | null> {
  const fallbackDelays = [2000, 5000];
  let lastError = false;
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetchWithTimeout(url, {}, 15000);
    } catch {
      lastError = true;
    }
    if (res?.ok) return res;
    const retryable = lastError || (res !== null && (res.status === 429 || res.status >= 500));
    if (!retryable || attempt >= fallbackDelays.length) return null;
    const retryAfter = res ? Number(res.headers.get("retry-after")) : Number.NaN;
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : fallbackDelays[attempt];
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 15000)));
    lastError = false;
  }
}

/** OpenAlex work 对象 → 补全结果 */
function openAlexToEnrichment(w: any): ReferenceEnrichment {
  return {
    source: "openalex",
    title: w?.display_name,
    authors: Array.isArray(w?.authorships)
      ? w.authorships.map((a: any) => a?.author?.display_name).filter(Boolean)
      : undefined,
    year: w?.publication_year?.toString(),
    venue: w?.primary_location?.source?.display_name,
    doi: typeof w?.doi === "string" ? w.doi.replace(/^https?:\/\/doi\.org\//, "") : undefined,
    abstract: rebuildAbstract(w?.abstract_inverted_index),
    landingPage: w?.primary_location?.landing_page_url ?? w?.doi,
    fetchedAt: Date.now(),
  };
}

/** OpenAlex 按 DOI 精确取（Crossref 无摘要时补摘要用） */
async function fetchOpenAlexByDoi(doi: string): Promise<any | null> {
  const res = await fetchWithTimeout(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`, {}, 12000);
  if (!res.ok) return null;
  return await res.json();
}

/** Crossref work message → 补全结果（doi 直查与 bibliographic 模糊兜底共用构造） */
async function crossrefMessageToEnrichment(m: any): Promise<ReferenceEnrichment> {
  const doi = m.DOI as string | undefined;
  let abstract = typeof m.abstract === "string" ? stripXml(m.abstract) : undefined;
  // Crossref 多数记录无摘要：按 DOI 补查 OpenAlex 的 abstract_inverted_index（P2.2 摘要口径）
  if (!abstract && doi) {
    try {
      const w = await fetchOpenAlexByDoi(doi);
      abstract = rebuildAbstract(w?.abstract_inverted_index);
    } catch {
      // 摘要补查失败不阻塞主结果
    }
  }
  return {
    source: "crossref",
    title: m.title?.[0],
    authors: Array.isArray(m.author)
      ? m.author.map((a: any) => [a?.given, a?.family].filter(Boolean).join(" ")).filter(Boolean)
      : undefined,
    year: m.issued?.["date-parts"]?.[0]?.[0]?.toString(),
    venue: m["container-title"]?.[0],
    doi,
    abstract,
    landingPage: m.resource?.primary?.URL ?? m.URL ?? (doi ? `https://doi.org/${doi}` : undefined),
    fetchedAt: Date.now(),
  };
}

async function enrichFromCrossref(doi: string): Promise<ReferenceEnrichment | null> {
  const res = await fetchWithTimeout(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {}, 12000);
  if (!res.ok) return null;
  const m = (await res.json())?.message;
  if (!m) return null;
  return crossrefMessageToEnrichment(m);
}

/** Semantic Scholar 按 arXiv 号直查（export.arxiv.org 无 CORS 头被 webview 拦，实测；S2 发 ACAO:*）。
 *  arXiv id 本身是精确标识，无需标题相似度校验。 */
async function enrichFromSemanticScholar(arxivId: string): Promise<ReferenceEnrichment | null> {
  const res = await fetchWithBackoff(
    // arXiv id 不 encodeURIComponent：%2F 编码斜杠经系统代理时 webview fetch 间歇性直接抛
    // Failed to fetch（实测 raw 3/3 通、%2F 3/3 抛）；arXiv id 字符集（字母/数字/斜杠/点/横线）本身安全
    `https://api.semanticscholar.org/graph/v1/paper/arXiv:${encodeURI(arxivId.trim())}?fields=title,authors,year,venue,abstract,externalIds`,
  );
  if (!res) return null;
  const w = await res.json();
  if (!w?.title) return null;
  return {
    source: "semanticscholar",
    title: w.title,
    authors: Array.isArray(w.authors) ? w.authors.map((a: any) => a?.name).filter(Boolean) : undefined,
    year: w.year?.toString(),
    venue: w.venue || undefined,
    doi: w.externalIds?.DOI ?? undefined,
    abstract: typeof w.abstract === "string" ? w.abstract : undefined,
    landingPage: `https://arxiv.org/abs/${arxivId}`,
    fetchedAt: Date.now(),
  };
}

async function enrichFromOpenAlex(title: string): Promise<ReferenceEnrichment | null> {
  const res = await fetchWithTimeout(
    `https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=3`,
    {},
    12000,
  );
  if (!res.ok) return null;
  const candidates = (await res.json())?.results;
  if (!Array.isArray(candidates)) return null;
  // 取标题相似度 ≥0.9 的首条（宁缺毋滥，不到阈值视为未解析）
  const best = candidates.find((w) => titleSimilarity(w?.display_name ?? "", title) >= 0.9);
  return best ? openAlexToEnrichment(best) : null;
}

/** raw 中抽取 4 位年份（19xx/20xx 首个） */
function extractYear(raw: string): string | null {
  const m = raw.match(/\b(?:19|20)\d{2}\b/);
  return m ? m[0] : null;
}

/**
 * 无标识符条目的最后兜底（老 APS 版式 title=null 无 doi/arxiv）：Crossref bibliographic 模糊匹配。
 * 模糊匹配错配比没有更糟，接受判据必须保守——候选需同时满足：
 *  (a) 年份与 raw 中抽取的 4 位年份一致（raw 无年份则该条豁免）；
 *  (b) 至少一个作者姓（family）出现在 raw 中；
 *  (c) container-title 与 raw 词级重合（APS 缩写按前缀算，如 Phys↔physical）或首名 score ≥ 次名 1.5 倍。
 */
async function enrichFromBibliographic(raw: string): Promise<ReferenceEnrichment | null> {
  const year = extractYear(raw);
  const res = await fetchWithTimeout(
    `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(raw)}&rows=3`,
    {},
    15000,
  );
  if (!res.ok) return null;
  const items = (await res.json())?.message?.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  const rawLower = raw.toLowerCase();
  const rawWords = rawLower.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const top = items[0];
  const second = items[1];
  const scoreGap =
    typeof top?.score === "number" && typeof second?.score === "number" && top.score >= second.score * 1.5;
  const accepted = items.find((w) => {
    if (!w) return false;
    // (a) 年份一致
    const wYear = w.issued?.["date-parts"]?.[0]?.[0]?.toString();
    if (year && wYear !== year) return false;
    // (b) 作者姓出现在 raw
    const families = Array.isArray(w.author)
      ? w.author.map((a: any) => String(a?.family ?? "").toLowerCase()).filter(Boolean)
      : [];
    if (families.length === 0 || !families.some((f: string) => rawLower.includes(f))) return false;
    // (c) venue 词级重合（前缀算重合）或 score 显著领先
    const containerWords = String(w["container-title"]?.[0] ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3);
    const venueOverlap = containerWords.some((cw) => rawWords.some((rw) => cw.startsWith(rw) || rw.startsWith(cw)));
    return venueOverlap || scoreGap;
  });
  return accepted ? crossrefMessageToEnrichment(accepted) : null;
}

/** 懒补全：DOI 走 Crossref（摘要缺时补 OpenAlex）→ arXiv 号走 Semantic Scholar → 标题走 OpenAlex 搜索
 *  → 全无用 Crossref bibliographic 保守模糊兜底 */
export async function enrichReference(ref: PaperReference): Promise<ReferenceEnrichment | null> {
  try {
    if (ref.doi) return await enrichFromCrossref(ref.doi);
    if (ref.arxiv_id) return await enrichFromSemanticScholar(ref.arxiv_id);
    if (ref.title) return await enrichFromOpenAlex(ref.title);
    return await enrichFromBibliographic(ref.raw);
  } catch (error) {
    console.warn(`参考文献元数据补全失败（[${ref.n}] ${ref.title ?? ref.raw.slice(0, 40)}）:`, error);
    return null;
  }
}

export interface LibraryPaperHit {
  id: string;
  title: string;
}

interface LibraryIndexEntry {
  id: string;
  title: string;
  doi?: string;
}

let libraryIndexPromise: Promise<LibraryIndexEntry[]> | null = null;

/** 本地论文库索引（id/title/doi）：doi 从各论文 metadata.json 懒读，会话级缓存（新入库后需失效重建） */
export function getLibraryPaperIndex(): Promise<LibraryIndexEntry[]> {
  libraryIndexPromise ??= (async () => {
    const papers = await listPapers();
    const base = await appDataDir();
    return Promise.all(
      papers.map(async (p) => {
        let doi: string | undefined;
        try {
          const meta = JSON.parse(await readTextFile(await join(base, "books", p.id, "metadata.json")));
          if (typeof meta?.doi === "string" && meta.doi.trim()) doi = meta.doi.trim().toLowerCase();
        } catch {
          // 无 metadata.json 或无 doi 字段：该篇只参与标题匹配
        }
        return { id: p.id, title: p.title, doi };
      }),
    );
  })().catch((error) => {
    libraryIndexPromise = null;
    throw error;
  });
  return libraryIndexPromise;
}

/** 新论文入库后调用，下次在库检查重建索引 */
export function invalidateLibraryPaperIndex(): void {
  libraryIndexPromise = null;
}

/** 在库检查：DOI 精确匹配优先 → 标题归一化相似（≥0.9 取最高分） */
export async function checkReferenceInLibrary(ref: {
  doi?: string;
  title?: string;
}): Promise<LibraryPaperHit | null> {
  const index = await getLibraryPaperIndex();
  const doi = ref.doi?.trim().toLowerCase();
  if (doi) {
    const hit = index.find((p) => p.doi && p.doi === doi);
    if (hit) return { id: hit.id, title: hit.title };
  }
  if (ref.title) {
    let best: { entry: LibraryIndexEntry; score: number } | null = null;
    for (const entry of index) {
      const score = titleSimilarity(entry.title, ref.title);
      if (score >= 0.9 && (!best || score > best.score)) best = { entry, score };
    }
    if (best) return { id: best.entry.id, title: best.entry.title };
  }
  return null;
}

/** 访问页面 URL 优先级：解析 landing_page → doi.org → arXiv abs 页 → Scholar 标题搜索兜底（永远有值） */
export function referenceLandingUrl(ref: PaperReference, enrichment?: ReferenceEnrichment | null): string {
  return (
    enrichment?.landingPage ??
    (ref.doi ? `https://doi.org/${ref.doi}` : undefined) ??
    (ref.arxiv_id ? `https://arxiv.org/abs/${ref.arxiv_id}` : undefined) ??
    `https://scholar.google.com/scholar?q=${encodeURIComponent(ref.title || ref.raw.slice(0, 120))}`
  );
}
