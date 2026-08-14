/**
 * 单篇 PDF 导入预转换去重（2026-08-15）。
 *
 * 背景：importPapers 的入库判重（id = SHA-256(paper.md)[..16]）发生在转换之后——
 * 重复 PDF 也要先烧一遍解析配额才被告知"已入库过"。本模块在队列启动前用
 * PDF 内容哈希把重复揪出来：
 * - 批内重复：一次拖入多份相同 PDF，只解析第一份；
 * - 库内重复：新 PDF 与库中论文的 source.pdf 哈希相同 → 跳过。
 *
 * 库内锚点（source.pdf 覆盖面差异）：
 * ① books/{id}/source.pdf（近期导入直接保留，覆盖少但映射直接）；
 * ② papers-converter/{slug}/source.pdf（解析 staging，102/102 全量）——
 *   由 staging paper.md 算出与 Rust scan_one_paper_dir 同口径的论文 id，
 *   id 命中库中书籍才算重复（只解析未入库的不误杀）。
 * 哈希经 asset 协议读文件 + WebCrypto SHA-256，纯前端实现；staging 扫描
 * 结果模块级缓存（source.pdf 入库后不再变化）。
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { listPapers } from "@/services/paper-service";

export interface DuplicateVerdict {
  kind: "library" | "batch";
  /** library：已在库的书名；batch：批内首份路径 */
  title?: string;
  firstPath?: string;
}

async function sha256Url(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`读取失败 HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Path(path: string): Promise<string> {
  return sha256Url(convertFileSrc(path));
}

/** 库内 PDF 哈希表（pdfHash → {bookId, title}）；会话级缓存 */
let libraryHashMap: Map<string, { id: string; title: string }> | null = null;

async function buildLibraryHashMap(): Promise<Map<string, { id: string; title: string }>> {
  if (libraryHashMap) return libraryHashMap;
  const map = new Map<string, { id: string; title: string }>();
  const papers = await listPapers();
  const base = await appDataDir();

  // 库内正文内容哈希 → 书籍（全文比对而非 id 反查：入库后编辑过正文的论文
  // id 已与内容脱钩，只有内容哈希对所有状态都成立）
  const paperMdHashMap = new Map<string, { id: string; title: string }>();
  await Promise.all(
    papers.map(async (p) => {
      try {
        const md = await join(base, "books", p.id, "paper.md");
        const hash = await sha256Path(md);
        paperMdHashMap.set(hash, { id: p.id, title: p.title });
      } catch {
        // 正文缺失（云端未下载）：该篇无法作锚
      }
    }),
  );

  // ① books/{id}/source.pdf 直接锚定
  await Promise.all(
    papers.map(async (p) => {
      try {
        const src = await join(base, "books", p.id, "source.pdf");
        const hash = await sha256Path(src);
        map.set(hash, { id: p.id, title: p.title });
      } catch {
        // 无 source.pdf 或读取失败：跳过该锚点
      }
    }),
  );

  // ② staging source.pdf → staging paper.md 全文哈希 → 命中库内正文才算
  try {
    const stagingRoot = await join(base, "papers-converter");
    const entries = await (await import("@tauri-apps/plugin-fs")).readDir(stagingRoot);
    await Promise.all(
      entries
        .filter((e) => e.isDirectory && !e.name.startsWith("_staging"))
        .map(async (e) => {
          try {
            const src = await join(stagingRoot, e.name, "source.pdf");
            const md = await join(stagingRoot, e.name, "paper.md");
            const [hash, mdHash] = await Promise.all([sha256Path(src), sha256Path(md)]);
            const book = paperMdHashMap.get(mdHash);
            if (book && !map.has(hash)) map.set(hash, { id: book.id, title: book.title });
          } catch {
            // 残缺 staging：跳过
          }
        }),
    );
  } catch {
    // papers-converter 目录不存在（全新环境）：无 staging 锚点
  }

  libraryHashMap = map;
  return map;
}

/**
 * 对一批待解析 PDF 做预转换去重。
 * 返回 重复路径 → 判定；不在返回值中的路径应继续进入解析队列。
 */
export async function findPaperDuplicates(paths: string[]): Promise<Map<string, DuplicateVerdict>> {
  const verdicts = new Map<string, DuplicateVerdict>();
  if (paths.length === 0) return verdicts;

  // 批内去重（同批同内容只留首份）
  const batchHashes = new Map<string, string>();
  const inputHashes = new Map<string, string>(); // path → hash（供库内比对）
  for (const p of paths) {
    try {
      const hash = await sha256Path(p);
      inputHashes.set(p, hash);
      const first = batchHashes.get(hash);
      if (first) {
        verdicts.set(p, { kind: "batch", firstPath: first });
      } else {
        batchHashes.set(hash, p);
      }
    } catch (e) {
      console.warn(`预去重哈希失败（继续按新文件处理）: ${p}`, e);
    }
  }

  // 库内去重（优先级高于批内：同一文件拖两份且已在库时，两份都应按“已在库”跳过，
  // 而不是首份漏判去转换烧配额——库内判定覆盖批内判定）
  try {
    const lib = await buildLibraryHashMap();
    for (const [p, hash] of inputHashes) {
      const hit = lib.get(hash);
      if (hit) verdicts.set(p, { kind: "library", title: hit.title });
    }
  } catch (e) {
    console.warn("库内哈希索引构建失败（跳过库内去重，仅批内生效）:", e);
  }

  return verdicts;
}
