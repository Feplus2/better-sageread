import type { DocRef } from "./shared";

/**
 * readDocument 图片路径重写（2026-10-22）：
 *
 * new 模式默认读原文，论文 paper.md / 书籍 mdbook 的 Markdown 里图片是相对路径
 * （如 images/p049.jpg），而 readImage 只收绝对路径。这里在返回文本前把「能解析到
 * 实际文件」的相对图片链接重写为绝对路径；解析不到时保留原文。
 * 调用方可用 resolveMissing 在磁盘未命中后解析并物化窗口资源（如 EPUB blob）。
 *
 * 库结构（与 getFigures、阅读位置桥一致）：
 * - 论文：{appData}/books/{paperId}/paper.md + {appData}/books/{paperId}/images/…
 * - 书籍：mdbook 产物 {appData}/books/{bookId}/mdbook/<book>/src/<mdRelPath>，
 *   md 内图片相对 md 文件所在目录（如 EPUB/images/x.jpg）；未转 mdbook 的旧书回落 book 目录
 *   （兼容 {bookDir}/images/… 这种顶层图片目录）。
 *
 * 本模块不直接依赖 Tauri：文件系统探测由调用方注入，便于 scripts/test-document-image-paths.mjs 单测。
 */

export interface DocImageFs {
  /** 文件是否存在 */
  exists(path: string): Promise<boolean>;
  /** 列目录下的子目录名（不存在/失败返回空数组） */
  listDir(path: string): Promise<string[]>;
}

export interface DocImageContext {
  kind: DocRef["kind"];
  /** {appData}/books/<docId>（论文与书籍同根） */
  docDir: string;
  /** 书籍 position 或 canonical segment 的 mdbook 相对路径（相对 mdbook src 根）。 */
  mdRelPath?: string;
  /** 全局 fallback 之前按 occurrence 解析（segment 结果不共享）；用于 canonical-book 窗口。 */
  resolveOccurrence?: (ref: string, index: number) => Promise<string | null>;
  /** 全局 fallback 仍未命中时按 occurrence 解析或物化资源。 */
  resolveMissing?: (ref: string, index: number) => Promise<string | null>;
}

const MARKDOWN_IMAGE_RE =
  /(?<!\\)!\[((?:\\[\s\S]|[^\\\]])*)\]\(\s*(<[^>\n]*>|[^)\s]+)((?:\s+"[^"]*"|\s+'[^']*'|\s+\([^)]*\))?)\s*\)/g;
const HTML_IMG_RE = /<img\b([^>]*?)\bsrc\s*=\s*("([^"]*)"|'([^']*)')([^>]*)>/gi;

function toSlashed(value: string): string {
  return value.replace(/\\/g, "/");
}

function stripAngle(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
}

/** 已经是绝对路径 / URL / data URI / 附件引用 / 纯锚点的图片引用不再处理 */
export function isLocalRelativeImageRef(ref: string): boolean {
  const value = stripAngle(ref);
  if (!value || value.startsWith("#")) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false; // Windows 盘符绝对路径
  if (value.startsWith("/") || value.startsWith("\\")) return false; // POSIX / UNC 绝对路径
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false; // http: / data: / attachment: 等
  return true;
}

/** 词法归一化：解析 ./ 与 ../，返回绝对路径；越出盘符根返回 null。 */
export function normalizeImagePath(path: string): string | null {
  const slashed = toSlashed(path).trim();
  const drive = /^([A-Za-z]:)(\/|$)/.exec(slashed)?.[1] ?? null;
  const rest = drive ? slashed.slice(drive.length) : slashed;
  const isAbsolute = drive != null || rest.startsWith("/");
  const segments: string[] = [];
  for (const segment of rest.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join("/");
  if (drive) return `${drive}/${joined}`;
  return isAbsolute ? `/${joined}` : joined;
}

/** base（绝对目录）+ 相对图片引用 -> 归一化绝对路径；仅接受绝对结果。 */
export function joinImagePath(base: string, ref: string): string | null {
  const baseSlashed = toSlashed(base).replace(/\/+$/, "");
  const refSlashed = toSlashed(stripAngle(ref)).replace(/^\/+/, "");
  if (!baseSlashed || !refSlashed) return null;
  const normalized = normalizeImagePath(`${baseSlashed}/${refSlashed}`);
  if (!normalized) return null;
  const isAbsolute = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/");
  return isAbsolute ? normalized : null;
}

function isWithinDir(candidate: string, dir: string): boolean {
  const target = toSlashed(candidate).toLowerCase();
  const root = toSlashed(dir).replace(/\/+$/, "").toLowerCase();
  return target === root || target.startsWith(`${root}/`);
}

/** 发现书籍 mdbook 的 src 根（约定 mdbook/<book>/src；兼容 mdbook/src 与更深一层）。 */
async function discoverMdbookSrcRoots(docDir: string, fs: DocImageFs): Promise<string[]> {
  const mdbookDir = `${docDir}/mdbook`;
  if (!(await fs.exists(mdbookDir))) return [];
  const roots: string[] = [];
  const direct = `${mdbookDir}/src`;
  if (await fs.exists(direct)) roots.push(direct);
  const children = (await fs.listDir(mdbookDir)).slice().sort();
  for (const child of children) {
    const childDir = `${mdbookDir}/${child}`;
    const childSrc = `${childDir}/src`;
    if (await fs.exists(childSrc)) {
      roots.push(childSrc);
      continue;
    }
    // 递归兜底（Rust find_mdbook_src_root 支持更深布局）：再下探一层
    for (const grandChild of (await fs.listDir(childDir)).slice().sort()) {
      const grandSrc = `${childDir}/${grandChild}/src`;
      if (await fs.exists(grandSrc)) roots.push(grandSrc);
    }
  }
  return roots;
}

function posixDirname(path: string): string {
  const slashed = toSlashed(path).replace(/\/+$/, "");
  const index = slashed.lastIndexOf("/");
  return index < 0 ? "" : slashed.slice(0, index);
}

async function resolveBookImagePath(ref: string, ctx: DocImageContext, fs: DocImageFs): Promise<string | null> {
  const docDir = toSlashed(ctx.docDir).replace(/\/+$/, "");
  if (ctx.mdRelPath) {
    const mdRelDir = posixDirname(ctx.mdRelPath);
    for (const srcRoot of await discoverMdbookSrcRoots(docDir, fs)) {
      const base = mdRelDir ? `${srcRoot}/${mdRelDir}` : srcRoot;
      const candidate = joinImagePath(base, ref);
      // 安全边界：mdbook 图片必须落在本书目录内（../ 不能逃出文献库目录）
      if (candidate && isWithinDir(candidate, docDir) && (await fs.exists(candidate))) return candidate;
    }
  }
  // 顶层图片目录兜底（{bookDir}/images/…，见 library-guide 的 <book_id>/images/ 约定）
  const fallback = joinImagePath(docDir, ref);
  if (fallback && isWithinDir(fallback, docDir) && (await fs.exists(fallback))) return fallback;
  return null;
}

async function resolvePaperImagePath(ref: string, ctx: DocImageContext, fs: DocImageFs): Promise<string | null> {
  const docDir = toSlashed(ctx.docDir).replace(/\/+$/, "");
  const candidate = joinImagePath(docDir, ref);
  if (candidate && isWithinDir(candidate, docDir) && (await fs.exists(candidate))) return candidate;
  return null;
}

export function resolveDocumentImagePath(ref: string, ctx: DocImageContext, fs: DocImageFs): Promise<string | null> {
  return ctx.kind === "paper" ? resolvePaperImagePath(ref, ctx, fs) : resolveBookImagePath(ref, ctx, fs);
}

interface ImageRefOccurrence {
  ref: string;
  index: number;
  key: string;
}

/** occurrence 优先；仅全局 fallback 按 ref 缓存，避免跨 spine 共享 segment 结果。 */
async function collectResolvedRefs(text: string, ctx: DocImageContext, fs: DocImageFs): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const diskResolved = new Map<string, string | null>();
  const occurrences: ImageRefOccurrence[] = [];
  let markdownOrdinal = 0;
  let htmlOrdinal = 0;
  MARKDOWN_IMAGE_RE.lastIndex = 0;
  HTML_IMG_RE.lastIndex = 0;
  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) {
    occurrences.push({ ref: match[2], index: match.index ?? 0, key: `markdown:${markdownOrdinal++}` });
  }
  for (const match of text.matchAll(HTML_IMG_RE)) {
    occurrences.push({ ref: match[3] ?? match[4] ?? "", index: match.index ?? 0, key: `html:${htmlOrdinal++}` });
  }
  for (const occurrence of occurrences) {
    const { ref, index, key } = occurrence;
    if (!isLocalRelativeImageRef(ref)) continue;
    const refPath = stripAngle(ref);
    let absolute: string | null = null;
    if (ctx.resolveOccurrence) {
      try {
        absolute = await ctx.resolveOccurrence(refPath, index);
      } catch {
        absolute = null;
      }
    }
    if (!absolute) {
      if (!diskResolved.has(refPath)) diskResolved.set(refPath, await resolveDocumentImagePath(refPath, ctx, fs));
      absolute = diskResolved.get(refPath) ?? null;
    }
    if (!absolute && ctx.resolveMissing) {
      try {
        absolute = await ctx.resolveMissing(refPath, index);
      } catch {
        absolute = null;
      }
    }
    if (absolute) resolved.set(key, absolute);
  }
  return resolved;
}

/**
 * 把文本中的相对图片链接重写为绝对路径（Markdown ![](rel) / ![alt](rel "title") / HTML <img src="rel">）。
 * - 只改图片链接，不动普通链接/正文；
 * - 已绝对/外部引用原样保留；解析不到或文件不存在的相对引用原样保留；
 * - 无图片或无改动时返回原字符串。
 */
export async function rewriteDocumentImagePaths(text: string, ctx: DocImageContext, fs: DocImageFs): Promise<string> {
  if (!text || (!text.includes("!") && !/<img/i.test(text))) return text;
  const resolved = await collectResolvedRefs(text, ctx, fs);
  if (resolved.size === 0) return text;

  let changed = false;
  let markdownOrdinal = 0;
  let htmlOrdinal = 0;
  MARKDOWN_IMAGE_RE.lastIndex = 0;
  HTML_IMG_RE.lastIndex = 0;
  const withMarkdown = text.replace(
    MARKDOWN_IMAGE_RE,
    (whole: string, alt: string, _destination: string, title = "") => {
      const absolute = resolved.get(`markdown:${markdownOrdinal++}`);
      if (!absolute) return whole;
      changed = true;
      return `![${alt}](${absolute}${title ? ` ${title.trim()}` : ""})`;
    },
  );
  HTML_IMG_RE.lastIndex = 0;
  const rewritten = withMarkdown.replace(
    HTML_IMG_RE,
    (whole: string, before: string, quoted: string, _doubleQuoted?: string, _singleQuoted?: string, after = "") => {
      const absolute = resolved.get(`html:${htmlOrdinal++}`);
      if (!absolute) return whole;
      changed = true;
      const quote = quoted.startsWith("'") ? "'" : '"';
      return `<img${before}src=${quote}${absolute}${quote}${after}>`;
    },
  );
  return changed ? rewritten : text;
}
