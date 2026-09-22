// E2E 冒烟：模型映射表远程热更新全链路（2026-09-22，随 MiMo-V2.6 入表验证）
// 覆盖：① app 活模块已生效新行（视觉/思考）；② refreshModelMaps 跑通且活表不劣于远程；
// ③ createMapRuntime 模拟旧客户端：版本闸（更旧拒绝/同版不抖/更晚整表替换）对真实远程字节生效。
// 运行：node scripts/cdp-test-model-maps-hotupdate.mjs（需 dev 实例 CDP 9223）
const LIST_URL = "http://127.0.0.1:9223/json/list";

// 远程真实字节由 node 侧拉取注入（页面 eval 无法解析裸 specifier @tauri-apps/plugin-http；
// app 自身的 tauriFetch 拉取链路由下面的 refreshModelMaps() 实跑覆盖）
const ts = Date.now();
const remoteVision = await (
  await fetch(`https://www.bettersageread.cn/maps/vision-map.json?_ts=${ts}`)
).json();
const remoteReasoning = await (
  await fetch(`https://www.bettersageread.cn/maps/reasoning-map.json?_ts=${ts}`)
).json();

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

  // ---- ① app 活模块（与应用同实例，不带 ?t=）：新行已生效 ----
  const v = await import(origin + "/src/ai/providers/vision-map.ts");
  const r = await import(origin + "/src/ai/providers/reasoning-map.ts");
  check("活表 mimo-v2.6-pro 视觉放行", v.modelSupportsVision("xiaomi", "mimo-v2.6-pro") === true, "");
  check("活表 mimo-v2.6-flash 视觉放行", v.modelSupportsVision("xiaomi", "mimo-v2.6-flash") === true, "");
  check("活表 mimo-v2.6-pro-ultraspeed 视觉放行", v.modelSupportsVision("xiaomi", "mimo-v2.6-pro-ultraspeed") === true, "");
  check("活表 mimo-v2.6-pro 思考 transport=switch", r.getReasoningTransport("mimo-v2.6-pro") === "switch", "");
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check("活表 mimo-v2.6-pro 档位 [off,on]", eq(r.getReasoningOptions("mimo-v2.6-pro"), ["off", "on"]), "");
  check("活表 mimo-v2.6-flash 档位 [off,on]", eq(r.getReasoningOptions("mimo-v2.6-flash"), ["off", "on"]), "");
  check("活表 v2.6 日期快照归一（-2026-09-22→基名）", eq(r.getReasoningOptions("mimo-v2.6-pro-2026-09-22"), ["off", "on"]), "");
  const applyPatch = (p) => { const body = {}; if (p) p(body); return body; };
  check("活表 v2.6 off→thinking.disabled", applyPatch(r.chatReasoningBodyPatch("xiaomi", "https://api.xiaomimimo.com/v1", "mimo-v2.6-pro", "off")).thinking?.type === "disabled", "");
  check("活表 v2.6 on→thinking.enabled", applyPatch(r.chatReasoningBodyPatch("xiaomi", "https://api.xiaomimimo.com/v1", "mimo-v2.6-flash", "on")).thinking?.type === "enabled", "");

  // ---- ② 真实拉取链路：refreshModelMaps（tauriFetch 出网）跑通；活表不劣于远程 ----
  const svc = await import(origin + "/src/services/model-maps-service.ts");
  await svc.refreshModelMaps();
  check("远程 vision 版本 2026-09-22", rv.updatedAt === "2026-09-22", rv.updatedAt);
  check("远程 reasoning 版本 2026-09-22", rr.updatedAt === "2026-09-22", rr.updatedAt);
  check("活表已是最新（同版远程不重复采纳）", v.adoptRemoteVisionMap(rv) === false && r.adoptRemoteReasoningMap(rr) === false, "");
  check("refresh 后活表仍含 v2.6 行", v.modelSupportsVision("xiaomi", "mimo-v2.6-pro") === true && eq(r.getReasoningOptions("mimo-v2.6-flash"), ["off", "on"]), "");

  // ---- ③ 模拟旧客户端：createMapRuntime 版本闸对真实远程字节 ----
  const { createMapRuntime } = await import(origin + "/src/ai/providers/maps/map-runtime.ts?t=" + Date.now());
  const visionValidator = (u) => (u && typeof u === "object" && !Array.isArray(u) && Object.values(u).every((x) => typeof x === "boolean") ? u : null);
  const oldClient = createMapRuntime({
    cacheKey: "hotupdateProbeCache",
    bundled: { updatedAt: "2026-09-20", models: { "mimo-v2.5": true } }, // 上一版客户端视角：无 v2.6 行
    validateModels: visionValidator,
  });
  check("旧客户端初始表无 v2.6", oldClient.current()["mimo-v2.6-pro"] === undefined, "");
  check("同版远程→不采纳（不抖动）", oldClient.adopt({ updatedAt: "2026-09-20", models: { "mimo-v2.5": true, extra: true } }) === false, "");
  check("更旧表→拒绝", oldClient.adopt({ updatedAt: "2026-09-01", models: { x: true } }) === false, "");
  check("非法载荷→拒绝", oldClient.adopt({ updatedAt: "2026-09-23", models: { x: 1 } }) === false, "");
  check("空表→拒绝（防擦空）", oldClient.adopt({ updatedAt: "2026-09-23", models: {} }) === false, "");
  check("真实远程 2026-09-22→采纳", oldClient.adopt(rv) === true, "");
  check("采纳后整表替换含 v2.6 三行", oldClient.current()["mimo-v2.6-pro"] === true && oldClient.current()["mimo-v2.6-flash"] === true && oldClient.current()["mimo-v2.6-pro-ultraspeed"] === true, "");
  check("采纳后版本戳=2026-09-22", oldClient.currentUpdatedAt() === "2026-09-22", "");
  const cached = JSON.parse(localStorage.getItem("hotupdateProbeCache") || "null");
  check("采纳表已写 localStorage 缓存", cached?.updatedAt === "2026-09-22" && cached?.models?.["mimo-v2.6-pro"] === true, "");
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
