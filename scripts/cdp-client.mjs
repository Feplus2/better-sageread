export async function connectPreview() {
  const cdpPort = process.env.CDP_PORT ?? "9224";
  const appPort = process.env.APP_PORT ?? "1421";
  const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const page = pages.find((target) => target.type === "page" && target.url?.includes(`localhost:${appPort}`));
  if (!page) throw new Error("找不到隔离 Preview");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    }
    return response.result?.value;
  };
  const previewDataDir = await evaluate(`(async () => (await import("/@id/@tauri-apps/api/path")).appDataDir())()`);
  if (!previewDataDir.includes("com.bettersageread.preview") && process.env.ALLOW_DAILY !== "1") {
    ws.close();
    throw new Error("拒绝在非隔离数据目录运行 CDP 探针");
  }
  return { ws, call, evaluate };
}
