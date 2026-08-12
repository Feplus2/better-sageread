// E2E 冒烟：Zotero 批量导入（扫描 + 纯函数，不跑真实 OCR 转换、不入库）
// 流程：python 生成 fixture 到临时目录 → CDP(9223) + vite 模块注入 → 页面上下文调服务层：
//   1) scanZoteroLibrary(fixtureDir)：collections 数量与嵌套、条目 1 doi/year/firstAuthor/hasPdf、
//      条目 3 hasPdf=false、未分类 1 篇
//   2) computeCandidates / summarizeCandidates：勾选边界与统计
//   3) matchExisting：状态表 merge / DOI 命中 / 标题相似+作者命中 / 全新条目 import
//   4) planFilingMerge：noop / apply / conflict 三分支
// 运行：node scripts/cdp-test-zotero-import.mjs（需 dev 实例以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 启动，
// 且 Rust 侧 zotero_scan_library 已实现；未实现时扫描组全部 FAIL 并给出提示）
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LIST_URL = "http://127.0.0.1:9223/json/list";
const FIXTURE_SCRIPT = fileURLToPath(new URL("./make-zotero-fixture.py", import.meta.url));

// 1. 生成 fixture（Windows 风格临时目录，直接可作 Tauri 命令的 dataDir 参数）
const fixtureDir = mkdtempSync(join(tmpdir(), "zotero-fixture-"));
execFileSync("python", [FIXTURE_SCRIPT, fixtureDir], { stdio: "inherit" });

// 2. 连接 CDP
const pages = await (await fetch(LIST_URL)).json();
const page = pages.find((p) => p.type === "page" && p.url?.includes("localhost:1420"));
if (!page) throw new Error("找不到 SageRead 页面（9223 CDP 未连接或未以调试端口启动）");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let mid = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function cdp(method, params = {}) {
  const id = ++mid;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

const expression = `
(async () => {
  const checks = [];
  const check = (name, pass, info) => checks.push({ name, pass: !!pass, info: info == null ? "" : String(info) });
  const origin = location.origin;
  const svc = await import(origin + "/src/services/zotero-import-service.ts");

  // ---- 扫描（走 Rust zotero_scan_library）----
  let scan = null;
  try {
    scan = await svc.scanZoteroLibrary(${JSON.stringify(fixtureDir)});
  } catch (e) {
    check("scan: 调通 zotero_scan_library", false, String(e) + "（Rust 侧命令未实现？）");
  }
  if (scan) {
    check("scan: collections 数量=2", scan.collections.length === 2, scan.collections.length);
    const colA = scan.collections.find((c) => c.name === "材料学");
    const colB = scan.collections.find((c) => c.name === "纳米材料");
    check("scan: collection A/B 名称", !!colA && !!colB, JSON.stringify(scan.collections.map((c) => c.name)));
    check("scan: B 嵌套于 A", !!colA && !!colB && colA.parentKey === null && colB.parentKey === colA.key,
      JSON.stringify({ a: colA?.parentKey ?? null, b: colB?.parentKey ?? null }));
    check("scan: items 数量=4（附件不计）", scan.items.length === 4, scan.items.length);

    const item1 = scan.items.find((i) => i.title === "Study of Flame Synthesis");
    check("scan: 条目 1 存在", !!item1, "");
    if (item1) {
      check("scan: 条目 1 doi", item1.doi === "10.1/abc", item1.doi);
      check("scan: 条目 1 year", (item1.year ?? "").startsWith("2016"), item1.year);
      check("scan: 条目 1 firstAuthor 含 Zhang", (item1.firstAuthor ?? "").includes("Zhang"), item1.firstAuthor);
      check("scan: 条目 1 hasPdf", item1.hasPdf === true && !!item1.pdfPath, item1.pdfPath);
      check("scan: 条目 1 归属 A", !!colA && item1.collectionKeys.includes(colA.key), JSON.stringify(item1.collectionKeys));
    }
    const item3 = scan.items.find((i) => i.title === "Review of Catalytic Nanomaterials");
    check("scan: 条目 3 hasPdf=false", !!item3 && item3.hasPdf === false && item3.pdfPath === null,
      item3 ? JSON.stringify({ hasPdf: item3.hasPdf, pdfPath: item3.pdfPath }) : "未找到");
    check("scan: 条目 3 同属 A+B", !!item3 && !!colA && !!colB && item3.collectionKeys.includes(colA.key) && item3.collectionKeys.includes(colB.key),
      item3 ? JSON.stringify(item3.collectionKeys) : "未找到");
    const unfiled = scan.items.filter((i) => i.collectionKeys.length === 0);
    check("scan: 未分类条目 1 篇且有 PDF", unfiled.length === 1 && unfiled[0].hasPdf === true,
      JSON.stringify(unfiled.map((i) => i.key)));

    // ---- computeCandidates / summarizeCandidates（勾选边界）----
    if (colA && colB) {
      const onlyA = svc.computeCandidates(scan, new Set([colA.key]));
      check("candidates: 仅勾 A → 2 篇（条目 1+3）", onlyA.length === 2, onlyA.length);
      const aPlusUnfiled = svc.computeCandidates(scan, new Set([colA.key, svc.UNFILED_KEY]));
      check("candidates: A+未分类 → 3 篇", aPlusUnfiled.length === 3, aPlusUnfiled.length);
      const allKeys = svc.computeCandidates(scan, new Set([colA.key, colB.key, svc.UNFILED_KEY]));
      check("candidates: 全选 → 4 篇去重", allKeys.length === 4, allKeys.length);
      const summary = svc.summarizeCandidates(onlyA, [], new Map());
      check("summarize: 仅勾 A → 新导入 2 / 无 PDF 1",
        summary.fresh === 2 && summary.existing === 0 && summary.noPdf === 1, JSON.stringify(summary));
    }
  }

  // ---- matchExisting（去重链纯函数）----
  const dedup = [
    { id: "p-old", zoteroKey: null, doi: null, title: "Previously Imported Paper", firstAuthor: null, year: null },
    { id: "p-doi", zoteroKey: null, doi: "https://doi.org/10.1/ABC", title: "Another Paper", firstAuthor: null, year: null },
    { id: "p-sim", zoteroKey: null, doi: null, title: "Study of Flame Syntheses", firstAuthor: "Zhang, San", year: "2016" },
  ];
  const stateByKey = new Map([["ITEM0001", { paperId: "p-old", zoteroKey: "ITEM0001", collectionKeys: [] }]]);
  const mkItem = (over) => ({
    key: "NEWKEY01", title: "x", doi: null, year: null, firstAuthor: null,
    collectionKeys: [], pdfPath: null, hasPdf: true, ...over,
  });
  const mMerge = svc.matchExisting(mkItem({ key: "ITEM0001" }), dedup, stateByKey);
  check("match: 状态表命中且论文在库 → merge", mMerge.kind === "merge" && mMerge.paperId === "p-old", JSON.stringify(mMerge));
  // 状态行指向已彻底清除的论文（paper.md 已不在）→ 落穿为全新导入（upsert 经 UNIQUE(zotero_key) 自愈）
  const mDead = svc.matchExisting(
    mkItem({ key: "ITEM0001" }),
    dedup,
    new Map([["ITEM0001", { paperId: "p-purged", zoteroKey: "ITEM0001", collectionKeys: [] }]]),
  );
  check("match: 状态行死链 → 落穿 import", mDead.kind === "import", JSON.stringify(mDead));
  const mDoi = svc.matchExisting(mkItem({ key: "NEWKEY02", doi: "10.1/abc", title: "No Match Title" }), dedup, new Map());
  check("match: DOI 命中（归一化去前缀） → adopt/doi",
    mDoi.kind === "adopt" && mDoi.via === "doi" && mDoi.paperId === "p-doi", JSON.stringify(mDoi));
  const mSim = svc.matchExisting(mkItem({ key: "NEWKEY03", title: "Study of Flame Synthesis", firstAuthor: "San Zhang" }), dedup, new Map());
  check("match: 标题相似+首作者 → adopt/title-similar",
    mSim.kind === "adopt" && mSim.via === "title-similar" && mSim.paperId === "p-sim", JSON.stringify(mSim));
  const mNew = svc.matchExisting(mkItem({ key: "NEWKEY04", title: "Completely Different Paper", doi: "10.9/zzz", firstAuthor: "Amy Chen" }), dedup, new Map());
  check("match: 全新条目 → import", mNew.kind === "import", JSON.stringify(mNew));

  // ---- planFilingMerge（三方合并纯函数）----
  const folderIdByKey = new Map([["A", "fA"], ["B", "fB"]]);
  const managed = new Set(["fA", "fB"]);
  const pNoop = svc.planFilingMerge({ zOld: ["A"], zNew: ["A"], localFolderIds: ["fA"], folderIdByKey, managedFolderIds: managed });
  check("merge: Zotero 侧未变 → noop", pNoop.kind === "noop", JSON.stringify(pNoop));
  const pApply = svc.planFilingMerge({ zOld: ["A"], zNew: ["A", "B"], localFolderIds: ["fA"], folderIdByKey, managedFolderIds: managed });
  check("merge: 本地未动 → apply (L−M(K))∪M(Znew)",
    pApply.kind === "apply" && JSON.stringify([...pApply.folderIds].sort()) === JSON.stringify(["fA", "fB"]), JSON.stringify(pApply));
  const pKeep = svc.planFilingMerge({ zOld: ["A"], zNew: ["B"], localFolderIds: ["fA", "fX"], folderIdByKey, managedFolderIds: managed });
  check("merge: apply 保留管辖外文件夹 fX",
    pKeep.kind === "apply" && JSON.stringify([...pKeep.folderIds].sort()) === JSON.stringify(["fB", "fX"]), JSON.stringify(pKeep));
  const pConflict = svc.planFilingMerge({ zOld: ["A"], zNew: ["B"], localFolderIds: [], folderIdByKey, managedFolderIds: managed });
  check("merge: 两边都动过 → conflict", pConflict.kind === "conflict", JSON.stringify(pConflict));

  return { checks };
})()
`;

const result = await cdp("Runtime.evaluate", {
  expression,
  awaitPromise: true,
  returnByValue: true,
  timeout: 60000,
});

const value = result.result?.result?.value;
ws.close();
if (!value?.checks) {
  console.error("CDP 调用失败:", JSON.stringify(result).slice(0, 600));
  process.exit(1);
}

let failed = 0;
for (const c of value.checks) {
  if (c.pass) {
    console.log(`✓ ${c.name}`);
  } else {
    failed += 1;
    console.error(`✗ ${c.name}${c.info ? ` —— ${c.info}` : ""}`);
  }
}
console.log(`\n${value.checks.length - failed}/${value.checks.length} 通过（fixture: ${fixtureDir}）`);
if (failed > 0) {
  console.error("FAIL");
  process.exit(1);
}
console.log("PASS");
