// 一次性存量修复（P2 入库缺口）：给已入库但缺 references.json 的论文从 papers-converter 输出目录补拷。
// 匹配依据：paper.md 内容 SHA-256 精确匹配（标题匹配太脆，目录 slug 有截断/哈希后缀）。
// 排除：forecast/cosmic/loops 三本（已是新版，备份链完整）与回收站条目。
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const APP_DATA = "C:/Users/20995/AppData/Roaming/com.bettersageread.dev";
const BOOKS = join(APP_DATA, "books");
const CONV = join(APP_DATA, "papers-converter");
const EXCLUDE = new Set(["57ae0a5f29feecb6", "6c533ac14d2b48e4", "53c07f0e159c4144", "3e313267790a815a"]);
const DRY = process.argv.includes("--dry");

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

// 回收站（books.trashed_at 非空）条目跳过——测试残留不值得补
const db = new DatabaseSync(join(APP_DATA, "database", "app.db"), { readOnly: true });
const trashed = new Set(db.prepare("SELECT id FROM books WHERE trashed_at IS NOT NULL").all().map((r) => r.id));
db.close();

// 转换器输出目录索引：paper.md 哈希 → references.json 路径
const convByHash = new Map();
for (const dir of readdirSync(CONV)) {
  const md = join(CONV, dir, "paper.md");
  const refs = join(CONV, dir, "references.json");
  if (!existsSync(md) || !existsSync(refs)) continue;
  try {
    convByHash.set(sha256(md), { dir, refs });
  } catch {}
}
console.log(`转换器输出带 references.json：${convByHash.size} 个目录`);

let copied = 0;
for (const bookId of readdirSync(BOOKS)) {
  if (EXCLUDE.has(bookId) || trashed.has(bookId)) continue;
  const bookDir = join(BOOKS, bookId);
  const md = join(bookDir, "paper.md");
  const refsDst = join(bookDir, "references.json");
  if (!existsSync(md) || existsSync(refsDst)) continue;
  let hit;
  try {
    hit = convByHash.get(sha256(md));
  } catch {
    continue;
  }
  if (!hit) continue;
  if (DRY) {
    console.log(`[dry] ${bookId} ← ${hit.dir}`);
  } else {
    copyFileSync(hit.refs, refsDst);
    console.log(`补拷 ${bookId} ← ${hit.dir}`);
  }
  copied += 1;
}
console.log(`完成：补拷 ${copied} 本`);
