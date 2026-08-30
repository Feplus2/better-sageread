// 源头级验证：getStyles 输出里的 hover 覆盖层规则色值 = 全局主题 primary 真值（明暗两套浓度）
// （批次 5：::highlight(book-align-hover) 已退役——CSS Custom Highlight 不支持圆角/阴影，
//   hover 层改为 iframe 内覆盖层 div，规则 .book-align-hover-rect / .book-align-hover-layer）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("未找到 dev 页面");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
};
await new Promise((resolve) => {
  ws.onopen = () => resolve();
});
const evalJS = async (expression) => {
  const r = await new Promise((res) => {
    const id = ++mid;
    pending.set(id, res);
    ws.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
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
  const i = css.indexOf(".book-align-hover-rect {");
  const j = css.indexOf(".book-align-hover-layer {");
  const theme = m.getThemeCode();
  const outerPrimary = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
  return {
    rectRule: i >= 0 ? css.slice(i, i + 260).replace(/\\s+/g, " ") : null,
    layerRule: j >= 0 ? css.slice(j, j + 120).replace(/\\s+/g, " ") : null,
    retired: !css.includes("::highlight(book-align-hover) {"),
    globalPrimary: theme.globalPrimary,
    outerPrimary,
    isDark: theme.isDarkMode,
  };
})()`);
console.log(
  "主题 globalPrimary:",
  result.globalPrimary,
  "| 外层 --primary:",
  result.outerPrimary,
  "| isDark:",
  result.isDark,
);
console.log("覆盖层容器规则:", result.layerRule ?? "未找到");
console.log("覆盖层 rect 规则:", result.rectRule ?? "未找到");
const bgExpect = `color-mix(in oklab, ${result.outerPrimary} ${result.isDark ? 20 : 14}%, transparent)`;
const shadowExpect = `color-mix(in oklab, ${result.outerPrimary} ${result.isDark ? 36 : 28}%, transparent)`;
const okBg = result.rectRule?.includes(bgExpect);
const okShadow = result.rectRule?.includes(shadowExpect);
const okRetired = result.retired;
console.log(
  okBg && okShadow && okRetired
    ? "ok - hover 覆盖层 = 全局主题 primary 真值 + 论文侧同浓度（含阴影），::highlight 规则已退役"
    : `FAIL - bg:${okBg} shadow:${okShadow} retired:${okRetired}（期望含 ${bgExpect} / ${shadowExpect}）`,
);
ws.close();
process.exit(0);
