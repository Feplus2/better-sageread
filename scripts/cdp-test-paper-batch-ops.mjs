// CDP 冒烟：文献库批量管理能力（不执行真实删除/转换/翻译）
// 覆盖：默认无复选框 → 点「管理」进模式（复选框+批量条出现，已选 0 操作禁用）→ 勾选计数 → 全选/取消选择
//   → 批量移动对话框打开与取消 → 「完成」退出（复选框消失）→ 重新解析来源解析（只读）
//      → 重新解析的 PDF 来源解析（zotero_pdf_path 命中 / source.pdf 分支 / 跳过注明）
// 运行：node scripts/cdp-test-paper-batch-ops.mjs（需 dev 实例以 9223 调试端口运行，页面会自动刷新一次）

const LIST_URL = "http://127.0.0.1:9223/json/list";

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

async function evaluate(expression, timeout = 60000) {
  const result = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout,
  });
  if (result.result?.exceptionDetails) {
    throw new Error(`页面脚本异常: ${JSON.stringify(result.result.exceptionDetails).slice(0, 500)}`);
  }
  return result.result?.result?.value;
}

// 先刷新页面，确保跑到最新构建（HMR 对路由级改动未必完全生效）
await cdp("Page.enable");
await cdp("Page.reload", { ignoreCache: true });
// ignoreCache 重载后模块全量重拉，启动较慢：轮询等应用真正渲染完成（最多 90s）
{
  const deadline = Date.now() + 90000;
  let ready = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      ready = await evaluate(
        `document.readyState === "complete" && !!document.querySelector("nav") && document.body.innerText.length > 500`,
      );
    } catch {
      ready = false; // 重载进行中，执行上下文暂不可用
    }
    if (ready) break;
  }
  if (!ready) {
    console.error("✗ 应用 90s 内未完成启动，冒烟终止");
    ws.close();
    process.exit(1);
  }
}

const expression = `
(async () => {
  const results = [];
  const record = (name, pass, note) => results.push({ name, pass: !!pass, note: note ?? "" });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const textOf = (el) => (el.textContent || "").replace(/\\s+/g, " ").trim();
  const findByText = (selector, re) =>
    [...document.querySelectorAll(selector)].find((el) => re.test(textOf(el)));
  const rowCheckboxes = () => [...document.querySelectorAll('[aria-label^="选择《"]')];
  const batchBarText = () => {
    const el = findByText("span", /已选\\s*\\d+\\s*篇/);
    return el ? textOf(el) : null;
  };
  // 以 app 实际加载的模块 URL 导入（HMR 后带 ?t= 时间戳；直接 import 裸路径会拿到另一个 store 实例）
  const appImport = async (path) => {
    const matches = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n.includes(path));
    const url = matches.sort().pop() ?? location.origin + path;
    return import(url);
  };

  try {
    // 0. 回到主页路由视图（可能有论文/书籍 tab 盖住路由页），并点击侧边栏 Link 导航到文献库。
    // 应用是 HashRouter（Link href="#/papers"）：导航判定看 location.hash；
    // 若历史测试用 pushState 把路径改成 /papers 形式，先归位回 hash 形式再点 Link。
    if (location.pathname !== "/") {
      history.replaceState({}, "", "/" + location.hash);
    }
    const layoutMod = await appImport("/src/store/layout-store.ts");
    const layoutState = layoutMod.useLayoutStore.getState();
    if (!layoutState.isHomeActive) layoutState.navigateToHome();
    // 等侧边栏 Link 出现（tab 视图切回 home 需要时间）
    let navLink = document.querySelector('a[href="#/papers"]');
    for (let i = 0; i < 20 && !navLink; i++) {
      await sleep(500);
      navLink = document.querySelector('a[href="#/papers"]');
    }
    if (navLink) navLink.click();
    // 等行业页标志：标题「文献库」
    let marker = findByText("h1", /^文献库$/);
    for (let i = 0; i < 40 && !marker; i++) {
      await sleep(500);
      marker = findByText("h1", /^文献库$/);
    }
    record(
      "导航到文献库页",
      location.hash.startsWith("#/papers") && marker != null,
      \`\${location.hash || location.pathname} / 标题\${marker ? "已渲染" : "未出现"}\`,
    );
    if (!marker) return results;

    // 1. 默认（非管理模式）无论文行 checkbox；等工具栏「管理」按钮出现（papers.length>0 才渲染工具栏）
    let manageBtn = null;
    for (let i = 0; i < 20; i++) {
      manageBtn = findByText("button", /^管理$/);
      if (manageBtn) break;
      await sleep(500);
    }
    record("默认无复选框（未进管理模式）", rowCheckboxes().length === 0, \`checkbox=\${rowCheckboxes().length}\`);
    record("工具栏含「管理」", manageBtn != null);
    if (!manageBtn) return results;

    // 2. 点「管理」→ 复选框出现 + 批量条出现（初始已选 0 篇，操作按钮禁用）
    manageBtn.click();
    await sleep(600);
    let rows = rowCheckboxes();
    record("管理模式：行复选框出现（≥2 篇）", rows.length >= 2, \`共 \${rows.length} 行\`);
    const bar0 = batchBarText();
    record("管理模式：批量条出现且初始已选 0", bar0 === "已选 0 篇", bar0);
    const moveBtn0 = findByText("button", /移动到…/);
    record("已选 0 时操作按钮禁用", moveBtn0?.disabled === true, \`disabled=\${moveBtn0?.disabled}\`);
    if (rows.length < 2) return results;

    // 3. 勾选前两行 → 计数正确
    rows[0].click();
    await sleep(300);
    rows[1].click();
    await sleep(500);
    const bar1 = batchBarText();
    record("勾选 2 行后计数为「已选 2 篇」", bar1 === "已选 2 篇", bar1);

    // 4. 全选 → 已选数 = 可见行数
    const selectAll = document.querySelector('[aria-label="全选当前列表"]');
    record("批量条含全选 checkbox", selectAll != null);
    if (selectAll) {
      selectAll.click();
      await sleep(500);
      const bar2 = batchBarText();
      record("全选后已选数 = 可见行数", bar2 === \`已选 \${rows.length} 篇\`, \`\${bar2} / 行数 \${rows.length}\`);
    }

    // 5. 取消选择 → 计数归 0，批量条仍在（管理不退出）
    const clearBtn = findByText("button", /取消选择/);
    record("批量条含「取消选择」", clearBtn != null);
    if (clearBtn) {
      clearBtn.click();
      await sleep(500);
      const bar3 = batchBarText();
      record("取消选择后归 0 且批量条仍在", bar3 === "已选 0 篇", bar3);
    }

    // 6. 重新勾选 2 行 → 打开批量移动对话框 → 断言替换语义文案 → 取消
    rows = rowCheckboxes();
    if (rows.length >= 2) {
      rows[0].click();
      await sleep(300);
      rows = rowCheckboxes();
      if (rows.length >= 2) rows[1].click();
      await sleep(500);
      const moveBtn = findByText("button", /移动到…/);
      record("批量条含「移动到…」", moveBtn != null, batchBarText());
      if (moveBtn) {
        moveBtn.click();
        await sleep(600);
        const dialog = document.querySelector('[role="dialog"]');
        const dialogText = dialog ? textOf(dialog) : "";
        record("批量移动对话框打开", dialog != null && dialogText.includes("批量移动到文件夹"));
        record(
          "对话框写明整体替换语义",
          dialogText.includes("将替换 2 篇论文的现有文件夹归属"),
          dialogText.slice(0, 120),
        );
        const cancelBtn = dialog ? findByText('[role="dialog"] button', /^取消$/) : null;
        if (cancelBtn) cancelBtn.click();
        // 大列表重渲染 + Radix 退出动画下关闭可能超过 500ms，轮询等待
        let closed = false;
        for (let i = 0; i < 10; i++) {
          await sleep(300);
          if (document.querySelector('[role="dialog"]') == null) {
            closed = true;
            break;
          }
        }
        record("取消后对话框关闭", closed);
      }
    }

    // 7. 「完成」退出管理模式 → 批量条与行复选框消失
    const doneBtn = findByText("button", /^完成$/);
    record("批量条含「完成」", doneBtn != null);
    if (doneBtn) {
      doneBtn.click();
      await sleep(500);
      record(
        "完成后退出管理模式（批量条与复选框消失）",
        batchBarText() == null && rowCheckboxes().length === 0,
        \`bar=\${batchBarText()} checkbox=\${rowCheckboxes().length}\`,
      );
    }

    // 6. 重新解析的 PDF 来源解析（真实数据只读探测，不触发转换）
    const [reparseSvc, paperSvc, pathApi, fsApi] = await Promise.all([
      appImport("/src/services/paper-reparse-service.ts"),
      appImport("/src/services/paper-service.ts"),
      appImport("/node_modules/.vite/deps/@tauri-apps_api_path.js"),
      appImport("/node_modules/.vite/deps/@tauri-apps_plugin-fs.js"),
    ]);
    const papers = await paperSvc.listPapers();
    const base = await pathApi.appDataDir();
    const metas = [];
    for (const p of papers) {
      try {
        const raw = await fsApi.readTextFile(await pathApi.join(base, "books", p.id, "metadata.json"));
        metas.push({ paper: p, meta: JSON.parse(raw) });
      } catch {
        metas.push({ paper: p, meta: {} });
      }
    }
    const withZotero = metas.find((m) => typeof m.meta?.zotero_pdf_path === "string" && m.meta.zotero_pdf_path);
    if (withZotero) {
      const resolved = await reparseSvc.resolvePaperSourcePdf(withZotero.paper.id, withZotero.meta);
      const zp = withZotero.meta.zotero_pdf_path;
      if (resolved === zp) {
        record("重新解析来源：zotero_pdf_path 命中", true, \`《\${withZotero.paper.title}》→ \${zp}\`);
      } else {
        // zotero 侧文件已不存在时应回退 source.pdf 或 null
        const sourcePdf = await pathApi.join(base, "books", withZotero.paper.id, "source.pdf");
        const hasSource = await fsApi.exists(sourcePdf).catch(() => false);
        const expected = hasSource ? sourcePdf : null;
        record(
          "重新解析来源：zotero_pdf_path 失效后正确回退",
          resolved === expected,
          \`resolved=\${resolved} expected=\${expected}\`,
        );
      }
    } else {
      // 库内没有真实的 zotero_pdf_path：用存在的文件做合成探测，断言存在性分支按序命中
      const probe = metas[0];
      if (probe) {
        const probePath = await pathApi.join(base, "books", probe.paper.id, "metadata.json");
        const resolved = await reparseSvc.resolvePaperSourcePdf(probe.paper.id, { zotero_pdf_path: probePath });
        record(
          "重新解析来源：zotero_pdf_path 存在性分支（合成探测，库内无真实回链）",
          resolved === probePath,
          \`resolved=\${resolved}\`,
        );
      }
      let sourceHit = null;
      for (const m of metas) {
        const sourcePdf = await pathApi.join(base, "books", m.paper.id, "source.pdf");
        if (await fsApi.exists(sourcePdf).catch(() => false)) {
          sourceHit = { ...m, sourcePdf };
          break;
        }
      }
      if (sourceHit) {
        const resolved = await reparseSvc.resolvePaperSourcePdf(sourceHit.paper.id, sourceHit.meta);
        record("重新解析来源：source.pdf 分支命中", resolved === sourceHit.sourcePdf, \`resolved=\${resolved}\`);
      } else {
        const resolved = probe ? await reparseSvc.resolvePaperSourcePdf(probe.paper.id, probe.meta) : "no-papers";
        record(
          "重新解析来源：库内无 source.pdf，断言落空为 null（注明跳过真实命中）",
          resolved === null || resolved === "no-papers",
          "首篇解析结果=" + resolved,
        );
      }
    }
  } catch (error) {
    results.push({ name: "页面脚本执行", pass: false, note: String(error?.stack ?? error).slice(0, 400) });
  } finally {
    // 收尾：清空选择并退出管理模式，避免污染用户后续操作
    const clearBtn = [...document.querySelectorAll("button")].find((el) =>
      /取消选择/.test((el.textContent || "").trim()),
    );
    if (clearBtn) clearBtn.click();
    const doneBtn = [...document.querySelectorAll("button")].find((el) =>
      /^完成$/.test((el.textContent || "").trim()),
    );
    if (doneBtn) doneBtn.click();
  }
  return results;
})()
`;

let results;
try {
  results = await evaluate(expression, 120000);
} finally {
  ws.close();
}
if (!results) {
  console.error("CDP 调用失败：无返回值");
  process.exit(1);
}

let failed = 0;
for (const r of results) {
  console.log(`${r.pass ? "✓" : "✗"} ${r.name}${r.note ? ` — ${r.note}` : ""}`);
  if (!r.pass) failed += 1;
}
console.log(`\n${results.length - failed}/${results.length} 项通过`);
if (failed > 0) process.exit(1);
