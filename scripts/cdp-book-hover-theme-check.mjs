// 源头级验证：getStyles 输出里的 ::highlight(book-align-hover) 色值 = 当前主题 palette primary（14% 浅色浓度）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("未找到 dev 页面");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
};
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expression) => {
  const r = await new Promise((res) => {
    const id = ++mid;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? "eval 失败").slice(0, 400));
  return r.result.value;
};

// HMR 版本化 URL（从 resource 条目解析；裸 import 拿旧实例）
const styleUrl = await evalJS(`(() => {
  const r = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/utils/style.ts"));
  return r ? new URL(r).pathname + new URL(r).search : null;
})()`);
if (!styleUrl) throw new Error("style.ts resource 未找到（未开书？先开一本书）");

const result = await evalJS(`(async () => {
  const m = await import(${JSON.stringify(styleUrl)});
  const s = await import("/src/store/app-settings-store.ts");
  const viewSettings = s.useAppSettingsStore.getState().settings.globalViewSettings;
  const css = m.getStyles(viewSettings);
  const i = css.indexOf("::highlight(book-align-hover)");
  const theme = m.getThemeCode();
  const outerPrimary = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
  return {
    rule: i >= 0 ? css.slice(i, i + 200).replace(/\\s+/g, " ") : null,
    globalPrimary: theme.globalPrimary,
    outerPrimary,
    isDark: theme.isDarkMode,
  };
})()`);
console.log("主题 globalPrimary:", result.globalPrimary, "| 外层 --primary:", result.outerPrimary, "| isDark:", result.isDark);
console.log("规则:", result.rule ?? "未找到");
const expect = `color-mix(in oklab, ${result.outerPrimary} ${result.isDark ? 20 : 14}%, transparent)`;
console.log(result.rule?.includes(expect) ? "ok - hover 高亮 = 全局主题 primary 真值 + 论文侧同浓度" : `FAIL - 期望含 ${expect}`);
ws.close();
process.exit(0);
