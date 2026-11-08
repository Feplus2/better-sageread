// Agent 时间感知验证（2026-10-20）：CDP 9223 连 dev 实例，动态 import /src/services/time-awareness.ts，
// 断言时间戳/当前时间两个纯函数口径与缓存稳定性：
// ① 历史消息时间戳固定格式 [YYYY-MM-DD HH:mm]（本机时区、24h、补零），秒/毫秒入参同口径；
// ② 当前时间段以【当前时间】开头、含周几与时区，并且永远压在尾部动态段（位置段之后）；
// ③ withMessageTimestamps：同一批消息连续调用两次（含对输出再调用一次）逐字节一致；user/assistant 均加前缀，
//    tool 不加、assistant 的 tool-call part 顺序不变；
// ④ 缺 createdAt 的消息不加前缀；仅末条 user（本轮新发）用发送时刻兜底。
// 前置：dev 实例在跑（CDP 9223 / localhost:1420）；本脚本只验证纯函数，不发起真实模型请求、不启动实例。
let failed = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log(`ok - ${msg}`);
  else {
    failed++;
    console.error(`FAIL - ${msg}${detail !== undefined ? ` | ${JSON.stringify(detail)}` : ""}`);
  }
};

/* ---------- CDP ---------- */
const cdpPort = process.env.CDP_PORT ?? "9223";
const appPort = process.env.APP_PORT ?? "1420";
let list;
try {
  list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
} catch (e) {
  throw new Error(`连不上 CDP ${cdpPort}（先启动 dev 实例）：${String(e)}`);
}
const page = list.find(
  (t) => t.type === "page" && (t.url.includes(`localhost:${appPort}`) || t.url.includes(`127.0.0.1:${appPort}`)),
);
if (!page) throw new Error(`未找到 dev 页面（localhost:${appPort}）`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (method, params) => {
  const id = ++mid;
  const promise = new Promise((resolve) => pending.set(id, { resolve }));
  ws.send(JSON.stringify({ id, method, params }));
  return promise;
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg.result);
    pending.delete(msg.id);
  }
};
await new Promise((r) => {
  ws.onopen = r;
});
const evalJS = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

/* ---------- 纯函数验证 ---------- */
const res = await evalJS(`
  (async () => {
    const ta = await import("/src/services/time-awareness.ts");
    const policy = await import("/src/constants/shared-policy.ts");

    // 用本地分量构造固定时刻，跨时区都能断言出确定文本：2024-03-05 09:07（周二）
    const local = new Date(2024, 2, 5, 9, 7, 0, 0);
    const ms = local.getTime();
    const sec = Math.floor(ms / 1000);

    const nowSection = ta.currentTimeSection(local);
    const nowSectionDefault = ta.currentTimeSection();
    const positionSection = "【当前阅读位置】\\n书籍：《示例》第三章 42%（md 字符 1234/3000）";
    const tailWithPosition = ta.composeDynamicTail(positionSection, local);
    const tailWithoutPosition = ta.composeDynamicTail("", local);
    const tailDegraded = ta.composeDynamicTail("【当前阅读位置】\\n章节：第三章（精确坐标暂不可用）", local);

    // ③ ModelMessage 注入：user(string) / assistant(array: text + tool-call) / tool
    const lookup = (_m, i) => (i <= 1 ? sec : undefined);
    const base = [
      { role: "user", content: "第一问" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "第一答" },
          { type: "tool-call", toolCallId: "call-1", toolName: "readBookSection", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call-1", toolName: "readBookSection", output: { type: "text", value: "正文" } },
        ],
      },
    ];
    const stampedA = ta.withMessageTimestamps(base, lookup);
    const stampedB = ta.withMessageTimestamps(base, lookup);
    const stampedTwice = ta.withMessageTimestamps(stampedA, lookup);

    // ④ buildTimestampLookup：历史缺 createdAt 不猜、有 createdAt 才加、末条 user 兜底、assistant→tool 拆分对齐
    const mkUi = (id, role, createdAt) => ({
      id,
      role,
      parts: [{ type: "text", text: id }],
      ...(createdAt ? { metadata: { createdAt } } : {}),
    });
    const nowMs = new Date(2026, 9, 20, 18, 37, 0, 0).getTime();
    const ui1 = [mkUi("u1", "user"), mkUi("a1", "assistant", sec), mkUi("u2", "user")];
    const model1 = [
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "u2" }] },
    ];
    const lookup1 = ta.buildTimestampLookup(ui1, model1, { now: nowMs });
    const mapped1 = ta.withMessageTimestamps(model1, lookup1);
    const mapped1Again = ta.withMessageTimestamps(model1, ta.buildTimestampLookup(ui1, model1, { now: nowMs }));
    const mapped1Later = ta.withMessageTimestamps(
      model1,
      ta.buildTimestampLookup(ui1, model1, { now: nowMs + 60000 }),
    );

    const ui2 = [mkUi("u3", "user", sec), mkUi("a3", "assistant", sec)];
    const model2 = [
      { role: "user", content: [{ type: "text", text: "u3" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c3", toolName: "readBookSection", input: {} }] },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c3", toolName: "readBookSection", output: { type: "text", value: "x" } }],
      },
    ];
    const mapped2 = ta.withMessageTimestamps(model2, ta.buildTimestampLookup(ui2, model2, { now: nowMs }));

    const firstText = (m) => (typeof m.content === "string" ? m.content : (m.content[0]?.text ?? ""));
    // 数组内容的时间前缀是独立 text part，拼起来便于断言「前缀 + 原文」
    const joinedText = (m) =>
      typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("");

    // transport 接线静态检查（Vite 开发服务器直接返回 TS 源码）：时间戳注入 + 动态段拼尾顺序
    let transportSrc = "";
    try {
      transportSrc = await (await fetch("/src/ai/custom-chat-transport.ts")).text();
    } catch {
      transportSrc = "";
    }
    const tailIdx = transportSrc.indexOf("(dynamicTail ?");
    const summaryMessageIdx = transportSrc.indexOf("injectConversationSummary(timestampedMessages");
    const systemPromptIdx = transportSrc.indexOf("await buildPrompt(chatContext)");
    const hasTimeInjection =
      transportSrc.includes("withMessageTimestamps(") &&
      transportSrc.includes("buildTimestampLookup(") &&
      transportSrc.includes("composeDynamicTail(");
    const summaryInMessagesAndTailLast =
      summaryMessageIdx > 0 && systemPromptIdx > summaryMessageIdx && tailIdx > systemPromptIdx;

    return {
      fixed: ta.formatTimestamp(ms),
      fixedFromSec: ta.formatTimestamp(sec),
      fixedRegex: /^\\[\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}\\]$/.test(ta.formatTimestamp(ms)),
      invalidEmpty: ta.formatTimestamp(Number.NaN) === "" && ta.formatTimestamp(0) === "",
      nowSection,
      nowSectionDefault,
      positionSection,
      tailWithPosition,
      tailWithoutPosition,
      tailDegraded,
      nowStarts: nowSectionDefault.startsWith("【当前时间】\\n"),
      nowHasWeekday: /周[一二三四五六日]/.test(nowSectionDefault),
      nowHasZone: /时区 \\S+/.test(nowSectionDefault),
      stable: JSON.stringify(stampedA) === JSON.stringify(stampedB) && JSON.stringify(stampedA) === JSON.stringify(stampedTwice),
      userPrefix: firstText(stampedA[0]),
      assistantPrefix: firstText(stampedA[1]),
      assistantKeepsToolCall:
        Array.isArray(stampedA[1].content) &&
        stampedA[1].content.some((p) => p.type === "tool-call" && p.toolCallId === "call-1") &&
        stampedA[1].content.length === 3,
      toolUntouched: stampedA[2] === base[2],
      mapped1: mapped1.map(joinedText),
      mapped1Stable: JSON.stringify(mapped1Again) === JSON.stringify(mapped1),
      mapped1HistoricalStable:
        JSON.stringify(mapped1Later.slice(0, 2)) === JSON.stringify(mapped1.slice(0, 2)),
      mapped2: mapped2.map(joinedText),
      assistantPartOrder:
        Array.isArray(stampedA[1].content) &&
        stampedA[1].content[0]?.type === "text" &&
        stampedA[1].content[0]?.text === "[2024-03-05 09:07] " &&
        stampedA[1].content[1]?.type === "text" &&
        stampedA[1].content[1]?.text === "第一答",
      mapped2ToolUntouched: mapped2[2] === model2[2],
      mapped2ToolCallKept:
        Array.isArray(mapped2[1].content) &&
        mapped2[1].content.some((p) => p.type === "tool-call" && p.toolCallId === "c3"),
      nowFallbackExpected: ta.formatTimestamp(nowMs),
      expectedSec: ta.formatTimestamp(sec),
      policyHasTimeRule:
        policy.SHARED_HOUSE_RULES.includes("时间感知") &&
        policy.SHARED_HOUSE_RULES.includes("不要臆测当前时间") &&
        policy.SHARED_HOUSE_RULES.includes("只读元数据"),
      hasTimeInjection,
      summaryInMessagesAndTailLast,
      summaryDebug: {
        summaryMessageIdx,
        systemPromptIdx,
        tailIdx,
        summarySnippet: transportSrc.slice(Math.max(0, summaryMessageIdx - 40), summaryMessageIdx + 120),
        systemSnippet: transportSrc.slice(Math.max(0, systemPromptIdx - 40), systemPromptIdx + 120),
        tailSnippet: transportSrc.slice(Math.max(0, tailIdx - 40), tailIdx + 120),
      },
    };
  })()
`);

/* ---------- 断言 ---------- */
// ① 历史消息时间戳：固定格式 + 秒/毫秒同口径 + 非法值不注入
ok(res.fixed === "[2024-03-05 09:07]", "formatTimestamp(固定毫秒) = [YYYY-MM-DD HH:mm]", res.fixed);
ok(res.fixedFromSec === res.fixed, "秒级 createdAt 与毫秒级输出一致（同一格式）", {
  ms: res.fixed,
  sec: res.fixedFromSec,
});
ok(res.fixedRegex, "时间戳严格匹配 [YYYY-MM-DD HH:mm]（不含相对时间词）", res.fixed);
ok(res.invalidEmpty, "非法/零时间戳返回空串（宁可不加不瞎编）", res.invalidEmpty);

// ② 当前时间：开头标题、周几、时区、压尾
ok(res.nowStarts, "currentTimeSection 以【当前时间】开头", res.nowSectionDefault);
ok(res.nowHasWeekday, "当前时间段含中文周几", res.nowSectionDefault);
ok(res.nowHasZone, "当前时间段含时区（Intl 解析）", res.nowSectionDefault);
ok(
  res.tailWithPosition.startsWith(res.positionSection) && res.tailWithPosition.endsWith(res.nowSection),
  "composeDynamicTail：位置段在前、当前时间压尾",
  { tail: res.tailWithPosition },
);
ok(
  res.tailWithoutPosition === res.nowSection,
  "位置段为空时仍注入当前时间（且当前时间就是最后一段）",
  res.tailWithoutPosition,
);
ok(
  res.tailDegraded.startsWith("【当前阅读位置】") && res.tailDegraded.endsWith(res.nowSection),
  "位置段降级时当前时间仍在最尾部",
  res.tailDegraded,
);

// ③ withMessageTimestamps：稳定 + user/assistant 加、tool 不加、part 顺序不变
ok(res.stable, "同一批消息连续两次注入（含对输出再注入一次）输出逐字节一致", res);
ok(res.userPrefix.startsWith("[2024-03-05 09:07] "), "user 消息加时间前缀", res.userPrefix);
ok(res.assistantPrefix.startsWith("[2024-03-05 09:07] "), "assistant 消息加时间前缀", res.assistantPrefix);
ok(res.assistantKeepsToolCall, "assistant 仅插入 text part：原 text + tool-call 数量不变", res.assistantKeepsToolCall);
ok(res.assistantPartOrder, "assistant 插入的 text part 在最前、原文与 tool-call 顺序不变", res.assistantPartOrder);
ok(res.toolUntouched, "tool 消息不加前缀（对象原样返回）", res.toolUntouched);

// ④ buildTimestampLookup：缺 createdAt 不猜、assistant→tool 对齐、末条 user 兜底
ok(res.mapped1[0] === "u1", "缺 createdAt 的历史 user 消息不加前缀", res.mapped1);
ok(res.mapped1[1].startsWith(res.expectedSec), "有 createdAt 的历史 assistant 消息加前缀", res.mapped1);
ok(res.mapped1[2] === `${res.nowFallbackExpected} u2`, "末条 user（本轮新发）用发送时刻兜底", {
  got: res.mapped1[2],
  expect: `${res.nowFallbackExpected} u2`,
});
ok(res.mapped1Stable, "buildTimestampLookup + 注入连续两轮输出一致（缓存友好）", res.mapped1);
ok(res.mapped1HistoricalStable, "下一轮当前时间变化时历史消息前缀逐字节稳定", res.mapped1HistoricalStable);
ok(res.mapped2[0].startsWith(res.expectedSec), "assistant→tool 拆分：user 消息仍正确取到自己的时间戳", res.mapped2);
ok(res.mapped2ToolUntouched, "assistant→tool 拆分：tool 消息不加前缀", res.mapped2);
ok(res.mapped2ToolCallKept, "assistant→tool 拆分：tool-call part 保留", res.mapped2);

// ⑤ transport 接线 + 共享规则
ok(
  res.hasTimeInjection,
  "transport 已接线：withMessageTimestamps + buildTimestampLookup + composeDynamicTail",
  res.hasTimeInjection,
);
ok(
  res.summaryInMessagesAndTailLast,
  "前情摘要注入消息切点，system 的 dynamicTail（位置+当前时间）保持最后",
  res.summaryDebug,
);
ok(res.policyHasTimeRule, "SHARED_HOUSE_RULES 注入时间感知规则", res.policyHasTimeRule);

console.log("\n---- 当前时间段时间预览 ----");
console.log(res.nowSectionDefault);
console.log("---- 动态段（位置+当前时间）预览 ----");
console.log(res.tailWithPosition);
console.log("----");

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
