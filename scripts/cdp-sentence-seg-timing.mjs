// 切句器实测耗时探针：当前章节全部块逐块计时 segmentSentences（兑现"毫秒级丝滑"承诺的数据）
import { connect, BOOK_ID } from "../.tmp-bt-verify/cdp-lib.mjs";

const { evalJs, sleep } = await connect();
const r = await evalJs(`(async () => {
  const res = (name, bare) => {
    const u = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes(name));
    // 未加载过的模块（本会话没开过论文 tab 时 paper-sentences 无 resource 条目）裸路径安全：
    // HMR 陷阱只影响被热更过的模块；这两个文件本轮未被热更则裸 import 即当前代码
    return u ? new URL(u).pathname + new URL(u).search : bare;
  };
  const L = (await import(res("/src/store/layout-store.ts", "/src/store/layout-store.ts"))).useLayoutStore;
  const rs = L.getState().readerStores?.get("reader-${BOOK_ID}");
  const view = rs?.getState().view;
  const c = view?.renderer?.getContents?.()?.[0];
  if (!c?.doc) return "no doc";
  const sb = await import(res("/src/services/book-translation/section-blocks.ts", "/src/services/book-translation/section-blocks.ts"));
  const ps = await import(res("/src/pages/paper-reader/paper-sentences.ts", "/src/pages/paper-reader/paper-sentences.ts"));
  const doc = c.doc;
  const blocks = sb.enumerateSectionBlocks(sb.wrapSectionDocument(doc));
  const times = [];
  let totalChars = 0;
  let totalSpans = 0;
  for (const b of blocks) {
    const map = sb.buildBlockTextMap(b.el);
    const t0 = performance.now();
    const spans = ps.segmentSentences(map.norm);
    const dt = performance.now() - t0;
    times.push(dt);
    totalChars += map.norm.length;
    totalSpans += spans.length;
  }
  times.sort((a, b) => a - b);
  const pick = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))] ?? 0;
  // 缓存命中对照：切句结果缓存后二次"命中"应为 ~0
  return JSON.stringify({
    chapterIndex: c.index, blocks: blocks.length, totalChars, totalSpans,
    p50: +pick(0.5).toFixed(3), p95: +pick(0.95).toFixed(3), max: +pick(1).toFixed(3),
    totalMs: +times.reduce((a, b) => a + b, 0).toFixed(2),
  });
})()`);
console.log(r);
process.exit(0);
