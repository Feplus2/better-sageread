// D4 图片一次性实盘冒烟（dev 实例内跑真实 Tauri fs）：落盘→引用→请求期物化/存根→readImage 工具
// 用法：node scripts/cdp-test-image-once.mjs（CDP 9223）
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
    }, 60000);
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

// 1x1 红色 PNG 的 dataUrl
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const out = await evalp(`(async () => {
  const res = {};
  const att = await import('/src/services/attachment-service.ts');
  // 1) 落盘 + 引用
  const ref = await att.saveImageAttachment('v7imgtest', '${TINY_PNG}', 'image/png');
  res.ref = ref;
  // 2) 读回
  const back = await att.readImageAttachment(ref);
  res.roundTrip = !!(back && back.dataUrl.startsWith('data:image/png;base64,'));
  // 3) 请求期物化/存根（真实函数 + 真实磁盘）
  const mp = await import('/src/ai/utils/message-processor.ts');
  const thread = [
    { id: 'u1', role: 'user', parts: [{ type: 'file', mediaType: 'image/png', url: ref, filename: '旧图.png' }, { type: 'text', text: '第一轮' }] },
    { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '好' }] },
    { id: 'u2', role: 'user', parts: [{ type: 'text', text: '第二轮' }, { type: 'file', mediaType: 'image/png', url: ref, filename: '新图.png' }] },
  ];
  const r = await mp.resolveImageAttachmentsForRequest(thread);
  res.agedStub = r[0].parts[0].type === 'text' && r[0].parts[0].text.includes(ref);
  res.lastMaterialized = r[2].parts[1].type === 'file' && String(r[2].parts[1].url).startsWith('data:image/png');
  res.originalUntouched = thread[0].parts[0].type === 'file' && thread[0].parts[0].url === ref;
  // 4) readImage 工具注册 + 执行
  const reg = await import('/src/ai/tools/registry.ts');
  const tools = reg.getToolsForScope('reader', { bookId: 'x' });
  res.readImageRegistered = typeof tools.readImage?.execute === 'function';
  const toolRes = await tools.readImage.execute({ ref }, { toolCallId: 't1', messages: [] });
  res.readImageReturnsImage = toolRes?.type === 'content' && toolRes.value?.some((p) => p.type === 'file' && String(p.url).startsWith('data:image/png'));
  return res;
})()`);
ws.close();

console.log(JSON.stringify(out, null, 1));
const fails = [];
if (!out.ref?.startsWith("attachment://")) fails.push("落盘引用异常");
if (!out.roundTrip) fails.push("读回失败");
if (!out.agedStub) fails.push("老轮次未存根化");
if (!out.lastMaterialized) fails.push("最后一条 user 未物化");
if (!out.originalUntouched) fails.push("存量消息被改动（违反请求期副本语义）");
if (!out.readImageRegistered) fails.push("readImage 未注册");
if (!out.readImageReturnsImage) fails.push("readImage 未返回图片");
if (fails.length) {
  console.error("FAIL:", fails.join(" | "));
  process.exit(1);
}
console.log("PASS: 图片一次性全链路（落盘→引用→存根/物化→readImage）");
