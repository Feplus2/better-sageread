// 5b 实盘验证：未翻译书 hover 单侧高亮 + 右键单击即选中+弹窗；翻译书右键单手势不回归
import { connect } from "../.tmp-bt-verify/cdp-lib.mjs";

const { evalJs, shot, sleep } = await connect();
let failed = 0;
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error(`FAIL - ${msg}`); } else { console.log(`ok - ${msg}`); }
};

const STORE = `performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/store/layout-store.ts"))`;

// 找一本未翻译的书（library 列表里挑一本非《必须保卫社会》的 EPUB；字段实测为 library/booksWithStatus）
const book = await evalJs(`(async () => {
  const L = (await import(${STORE})).useLayoutStore;
  const libMod = await import(performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/store/library-store.ts")) ?? "/src/store/library-store.ts");
  const st = libMod.useLibraryStore.getState();
  const books = st.booksWithStatus ?? []; // library 字段是空数组（非 nullish），?? 不兜底；实测以此为准
  return books
    .map((b) => ({ id: b.id ?? b.hash, title: b.title, format: (b.format ?? "").toUpperCase(), deletedAt: b.deletedAt ?? b.deleted_at }))
    .filter((b) => b.format === "EPUB" && !b.deletedAt && b.id !== "7a87db6c21dba74df45c7061c15c9951");
})()`);
console.log("候选未翻译书:", JSON.stringify(book?.slice(0, 5)));
if (!book?.length) throw new Error("没有可用的未翻译 EPUB");
const target = book[0];

// 打开它
await evalJs(`(async () => {
  const L = (await import(${STORE})).useLayoutStore;
  await L.getState().openBook(${JSON.stringify(target.id)}, ${JSON.stringify(target.title)});
})()`);
await sleep(8000);

// hover 探针：对正文段中心派生合成 mousemove（走 rAF 节流，等 200ms），查覆盖层
const hoverProbe = async (label) => {
  const r = await evalJs(`(async () => {
    const url = ${STORE};
    const L = (await import(url)).useLayoutStore;
    const rs = L.getState().readerStores?.get("reader-" + ${JSON.stringify(target.id)});
    const view = rs?.getState().view;
    const c = view?.renderer?.getContents?.()?.[0];
    if (!c?.doc) return "no doc";
    const doc = c.doc;
    const win = doc.defaultView;
    const p = doc.querySelector("p");
    if (!p) return "no p";
    const rect = p.getBoundingClientRect();
    const x = rect.left + Math.min(60, rect.width / 2);
    const y = rect.top + Math.min(12, rect.height / 2);
    const el = doc.elementFromPoint(x, y) ?? p;
    el.dispatchEvent(new win.MouseEvent("mousemove", { bubbles: true, cancelable: true, clientX: x, clientY: y, view: win }));
    await new Promise((r2) => setTimeout(r2, 300));
    const layer = doc.querySelector(".book-align-hover-layer");
    const rects = layer ? layer.querySelectorAll(".book-align-hover-rect").length : 0;
    const selText = "";
    return JSON.stringify({ layer: !!layer, rects, tag: el.tagName, para: p.textContent.slice(0, 40) });
  })()`);
  console.log(`${label}:`, r);
  return r;
};

const h1 = await hoverProbe("未翻译书 hover");
assert(h1 !== "no doc" && h1 !== "no p", "文档与段落就绪");
const hp = JSON.parse(h1.startsWith("{") ? h1 : "{}");
assert(hp.layer === true && hp.rects > 0, "未翻译书 hover 产生单侧句级覆盖层");

// 右键探针：派发 contextmenu → 应立即选中 + 弹窗（单手势）
const ctx = await evalJs(`(async () => {
  const url = ${STORE};
  const L = (await import(url)).useLayoutStore;
  const rs = L.getState().readerStores?.get("reader-" + ${JSON.stringify(target.id)});
  const view = rs?.getState().view;
  const c = view?.renderer?.getContents?.()?.[0];
  const doc = c.doc; const win = doc.defaultView;
  const p = doc.querySelector("p");
  const rect = p.getBoundingClientRect();
  const x = rect.left + Math.min(60, rect.width / 2);
  const y = rect.top + Math.min(12, rect.height / 2);
  const el = doc.elementFromPoint(x, y) ?? p;
  el.dispatchEvent(new win.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, view: win, button: 2 }));
  await new Promise((r2) => setTimeout(r2, 800));
  const sel = doc.getSelection();
  const selected = sel && !sel.isCollapsed ? sel.toString() : "";
  // 弹窗在宿主 DOM（annotator AnnotationPopup）——找包含「复制」/「Ask AI」的按钮
  const popup = [...document.querySelectorAll("button,div")].some((n) => n.textContent?.trim() === "Ask AI" || n.textContent?.trim() === "复制");
  return JSON.stringify({ selectedLen: selected.length, selected: selected.slice(0, 60), popup });
})()`);
console.log("右键:", ctx);
const cp = JSON.parse(ctx.startsWith("{") ? ctx : "{}");
assert(cp.selectedLen > 10, `右键选中整句（${cp.selectedLen} 字符）`);
assert(cp.popup === true, "单击右键即浮起标注弹窗（同手势）");

await shot("bt-5b-untranslated-hover");
console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
