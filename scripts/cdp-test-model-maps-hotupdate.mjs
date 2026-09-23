// E2E 冒烟：模型映射表远程热更新全链路（2026-09-22 随 MiMo-V2.6 入表首次验证；
// 2026-09-23 起改为参数化——预期版本戳/关键行从打包表读出，不再硬编码日期）
// 覆盖：① app 活模块已生效当前打包表（抽查近期入表行）；② refreshModelMaps 真实拉取跑通，
// 活表不劣于远程；③ createMapRuntime 模拟旧客户端：版本闸（更旧拒绝/同版不抖/更晚整表
// 替换/写缓存）对真实远程字节生效。
// 前提：远程已部署到与打包表同版（push main 后约 1 分钟）。
// 运行：node scripts/cdp-test-model-maps-hotupdate.mjs（需 dev 实例 CDP 9223）
import { readFileSync } from "node:fs";

const LIST_URL = "http://127.0.0.1:9223/json/list";

// 期望 = 打包表（部署完成后远程应与打包同版）；远程真实字节由 node 侧拉取注入
// （页面 eval 无法解析裸 specifier @tauri-apps/plugin-http；app 自身的 tauriFetch
// 拉取链路由下面的 refreshModelMaps() 实跑覆盖）
const bundledVision = JSON.parse(readFileSync("packages/app/src/ai/providers/maps/vision-map.json", "utf8"));
const bundledReasoning = JSON.parse(readFileSync("packages/app/src/ai/providers/maps/reasoning-map.json", "utf8"));
const ts = Date.now();
const remoteVision = await (
  await fetch(`https://www.bettersageread.cn/maps/vision-map.json?_ts=${ts}`)
).json();
const remoteReasoning = await (
  await fetch(`https://www.bettersageread.cn/maps/reasoning-map.json?_ts=${ts}`)
).json();

// 抽查行（每批新型号入表后在此追加；视觉值须为 true，思考给出期望 levels）
const VISION_SPOT = ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed", "claude-opus-5-5", "gpt-6-sol", "gpt-6-luna", "grok-4.7"];
const REASONING_SPOT = {
  "mimo-v2.6-pro": ["off", "on"],
  "gpt-6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
  "grok-4.7": ["none", "low", "medium", "high", "xhigh"],
};

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
  const rv = ${JSON.stringify(remoteVision)};
  const rr = ${JSON.stringify(remoteReasoning)};
  const expectV = ${JSON.stringify(bundledVision.updatedAt)};
  const expectR = ${JSON.stringify(bundledReasoning.updatedAt)};
  const visionSpot = ${JSON.stringify(VISION_SPOT)};
  const reasoningSpot = ${JSON.stringify(REASONING_SPOT)};
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // ---- ① app 活模块（与应用同实例，不带 ?t=）：打包表已生效 ----
  const v = await import(origin + "/src/ai/providers/vision-map.ts");
  const r = await import(origin + "/src/ai/providers/reasoning-map.ts");
  for (const m of visionSpot) check("活表视觉放行 " + m, v.modelSupportsVision("xiaomi", m) === true, "");
  for (const [m, levels] of Object.entries(reasoningSpot)) check("活表思考档位 " + m, eq(r.getReasoningOptions(m), levels), JSON.stringify(r.getReasoningOptions(m)));
  check("活表 v2.6 日期快照归一（-2026-09-22→基名）", eq(r.getReasoningOptions("mimo-v2.6-pro-2026-09-22"), reasoningSpot["mimo-v2.6-pro"]), "");
  const applyPatch = (p) => { const body = {}; if (p) p(body); return body; };
  check("活表 v2.6 off→thinking.disabled", applyPatch(r.chatReasoningBodyPatch("xiaomi", "https://api.xiaomimimo.com/v1", "mimo-v2.6-pro", "off")).thinking?.type === "disabled", "");
  check("活表 gpt-6-sol max→providerOptions effort max", r.chatReasoningProviderOptions("openai", "gpt-6-sol", "max")?.openai?.reasoningEffort === "max", "");

  // ---- ② 真实拉取链路：refreshModelMaps（tauriFetch 出网）跑通；远程=打包同版；活表不劣于远程 ----
  const svc = await import(origin + "/src/services/model-maps-service.ts");
  await svc.refreshModelMaps();
  check("远程 vision 版本=打包 " + expectV, rv.updatedAt === expectV, rv.updatedAt);
  check("远程 reasoning 版本=打包 " + expectR, rr.updatedAt === expectR, rr.updatedAt);
  check("活表已是最新（同版远程不重复采纳）", v.adoptRemoteVisionMap(rv) === false && r.adoptRemoteReasoningMap(rr) === false, "");
  check("refresh 后活表抽查行仍在", visionSpot.every((m) => v.modelSupportsVision("xiaomi", m) === true), "");

  // ---- ③ 模拟旧客户端：createMapRuntime 版本闸对真实远程字节 ----
  const { createMapRuntime } = await import(origin + "/src/ai/providers/maps/map-runtime.ts?t=" + Date.now());
  const visionValidator = (u) => (u && typeof u === "object" && !Array.isArray(u) && Object.values(u).every((x) => typeof x === "boolean") ? u : null);
  const oldClient = createMapRuntime({
    cacheKey: "hotupdateProbeCache",
    bundled: { updatedAt: "2000-01-01", models: { legacy: true } }, // 旧客户端视角：无新行
    validateModels: visionValidator,
  });
  check("旧客户端初始表无新行", oldClient.current()[visionSpot[0]] === undefined, "");
  check("同版→不采纳（不抖动）", oldClient.adopt({ updatedAt: "2000-01-01", models: { legacy: true, extra: true } }) === false, "");
  check("更旧表→拒绝", oldClient.adopt({ updatedAt: "1999-12-31", models: { x: true } }) === false, "");
  check("非法载荷→拒绝", oldClient.adopt({ updatedAt: "2999-01-01", models: { x: 1 } }) === false, "");
  check("空表→拒绝（防擦空）", oldClient.adopt({ updatedAt: "2999-01-01", models: {} }) === false, "");
  check("真实远程→采纳", oldClient.adopt(rv) === true, "");
  check("采纳后整表替换含抽查行", visionSpot.every((m) => oldClient.current()[m] === true), "");
  check("采纳后版本戳=远程", oldClient.currentUpdatedAt() === rv.updatedAt, "");
  const cached = JSON.parse(localStorage.getItem("hotupdateProbeCache") || "null");
  check("采纳表已写 localStorage 缓存", cached?.updatedAt === rv.updatedAt && visionSpot.every((m) => cached?.models?.[m] === true), "");
  check("采纳后再收同版→不重复采纳", oldClient.adopt(rv) === false, "");
  localStorage.removeItem("hotupdateProbeCache");

  return checks;
})()
`;

const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
const checks = result.result?.result?.value;
if (!Array.isArray(checks)) {
  console.error("页面上下文执行失败:", JSON.stringify(result).slice(0, 1200));
  process.exit(1);
}

let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.info ? `  | ${c.info}` : ""}`);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} PASS`);
ws.close();
process.exit(pass === checks.length ? 0 : 1);
