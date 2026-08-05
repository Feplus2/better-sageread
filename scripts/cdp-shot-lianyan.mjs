// 启用怜烟主题并截图（用法：node scripts/cdp-shot-lianyan.mjs [dark|light]）
const mode = process.argv[2] === "dark" ? "dark" : "light";
const LIST_URL = "http://127.0.0.1:9223/json/list";
const pages = await (await fetch(LIST_URL)).json();
const page = pages.find((p) => p.type === "page" && p.url?.includes("localhost:1420"));
if (!page) throw new Error("找不到 SageRead 页面");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cdp = (method, params = {}) => { const id = ++mid; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };

await cdp("Runtime.evaluate", {
  expression: `localStorage.setItem("globalTheme", "lianyan"); localStorage.setItem("themeMode", "${mode}"); "ok"`,
});
await cdp("Page.enable");
await cdp("Page.reload", { ignoreCache: true });
await new Promise((r) => setTimeout(r, 9000));

const videoState = await cdp("Runtime.evaluate", {
  expression: `(() => { const v = document.querySelector("video"); return JSON.stringify({ hasVideo: !!v, src: v?.src ?? null, playing: v ? !v.paused : false, size: v ? v.videoWidth + "x" + v.videoHeight : null }); })()`,
  returnByValue: true,
});
console.log("video:", videoState.result?.result?.value);

const shot = await cdp("Page.captureScreenshot", { format: "png" });
const { writeFileSync } = await import("node:fs");
const out = `.tools/lianyan-${mode}.png`;
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
console.log("saved:", out);
ws.close();
