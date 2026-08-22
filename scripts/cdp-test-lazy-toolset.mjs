// D8 目录牌模式实盘验证：reader 工具池超预算自动启用；目录牌体积；describeTool/useTool 真工具链路
// 用法：node scripts/cdp-test-lazy-toolset.mjs（dev 实例 CDP 9223）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) {
  console.error("未找到应用页面");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时: ${method}`));
    }, 120000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalp = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  return r.result?.result?.value;
};

const out = await evalp(`(async () => {
  const res = {};
  const bust = '?t=' + Date.now();
  const reg = await import('/src/ai/tools/registry.ts' + bust);
  const lazy = await import('/src/ai/tools/lazy-toolset.ts' + bust);
  const bookId = '210b093441669653de55a5109238fc67';
  // 内置工具池（无 MCP 连接的保守面）
  const tools = reg.getToolsForScope('reader', { bookId });
  res.builtinCount = Object.keys(tools).length;
  res.builtinChars = lazy.estimateToolsChars(tools);
  res.directoryOnBuiltin = lazy.shouldUseDirectoryMode(tools);
  // 模拟挂重连接器：10 个服务器 × 6 工具（胖 schema）→ 必须进目录牌且目录牌体积近似线性
  const fat = {};
  for (const [n, t] of Object.entries(tools)) fat[n] = t;
  for (let s = 0; s < 10; s++) {
    for (let k = 0; k < 6; k++) {
      fat['mcp_srv' + s + '_tool' + k] = { description: '服务器' + s + '的工具' + k + '：' + '详'.repeat(120), inputSchema: { type: 'object', properties: { a: { type: 'string', description: '参数' } } }, execute: () => ({}) };
    }
  }
  res.fatCount = Object.keys(fat).length;
  res.fatChars = lazy.estimateToolsChars(fat);
  res.directoryOnFat = lazy.shouldUseDirectoryMode(fat);
  const board = lazy.buildToolDirectoryBoard(fat);
  res.boardChars = board.length;
  res.boardRatio = +(res.boardChars / res.fatChars).toFixed(3);
  // 惰性链路：describeTool 拿 ragSearch schema → useTool 执行 getBooks 真工具
  const lazySet = lazy.buildLazyToolset(fat);
  const d = await lazySet.describeTool.execute({ tool: 'ragSearch' }, {});
  res.describeOk = !!(d.success && String(d.input_schema).includes('question'));
  const u = await lazySet.useTool.execute({ tool: 'getBooks', args: {} }, { toolCallId: 't1' });
  res.useToolOk = Array.isArray(u?.results?.books ?? u?.books ?? u?.results) || JSON.stringify(u).includes('title');
  return res;
})()`);
ws.close();

console.log(JSON.stringify(out, null, 1));
const fails = [];
if (out.directoryOnFat !== true) fails.push("重连接器场景未进目录牌模式");
if (out.boardChars > 80 * 90) fails.push(`目录牌超线性膨胀 ${out.boardChars}`);
if (!out.describeOk) fails.push("describeTool 未返回 ragSearch schema");
if (!out.useToolOk) fails.push("useTool 未执行 getBooks");
if (fails.length) {
  console.error("FAIL:", fails.join(" | "));
  process.exit(1);
}
console.log("PASS: 目录牌模式（预算守门 + 体积近似线性 + 惰性双 meta-tool 真链路）");
