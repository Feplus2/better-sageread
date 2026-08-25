// sync-e2e 公共库：路径常量、云端文件读写、sync-state 读取、CDP 连接
// 云端即 dufs 服务的本地目录，直接 fs 读写（等价于 WebDAV 视角）
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export const CLOUD_ROOT = "F:/MyProjects/SageRead/.tmp-webdav-root";
export const CLOUD_L2 = path.join(CLOUD_ROOT, "bettersageread/sync");
export const A_DIR = "C:/Users/20995/AppData/Roaming/com.bettersageread.dev2";
export const B_DIR = "C:/Users/20995/AppData/Roaming/com.bettersageread.dev3";
export const A_LOCAL = "C:/Users/20995/AppData/Local/com.bettersageread.dev2";
export const B_LOCAL = "C:/Users/20995/AppData/Local/com.bettersageread.dev3";
export const A_CDP = 9224;
export const B_CDP = 9225;
export const EVIDENCE_DIR = "F:/MyProjects/SageRead/.tmp-e2e/evidence";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function ensureEvidenceDir() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

/** 读 sync-state.json（带 JSON 合法性校验；非法时返回 {__invalid: raw}） */
export function readSyncState(dir) {
  const p = path.join(dir, "sync-state.json");
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return { __invalid: raw.slice(0, 500) };
  }
}

export function readCloudJson(rel) {
  const p = path.join(CLOUD_L2, rel);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function writeCloudJson(rel, obj) {
  const p = path.join(CLOUD_L2, rel);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

export function listCloudFiles(relDir) {
  const p = path.join(CLOUD_L2, relDir);
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p).sort();
}

/** 找实例当前日志文件（tauri-plugin-log：Local/<identifier>/logs/ 下取最新 .log） */
export function findLogFile(localDir) {
  const dir = path.join(localDir, "logs");
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".log"))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? path.join(dir, files[0].f) : null;
}

/** 读日志尾部（从 offset 起；返回 {text, offset}） */
export function tailLog(logFile, offset = 0) {
  if (!logFile || !fs.existsSync(logFile)) return { text: "", offset: 0 };
  const size = fs.statSync(logFile).size;
  const start = Math.min(offset, size);
  const fd = fs.openSync(logFile, "r");
  const buf = Buffer.alloc(size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  return { text: buf.toString("utf8"), offset: size };
}

/** 等 cond() 为真，超时返回 false */
export async function waitFor(cond, timeoutMs = 120000, intervalMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await cond();
    if (v) return v;
    await sleep(intervalMs);
  }
  return false;
}

/* ---------------- CDP ---------------- */

function getPageWs(port) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/json`, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            const page = JSON.parse(buf).find((t) => t.type === "page");
            page ? resolve(page.webSocketDebuggerUrl) : reject(new Error("no page target"));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

/** 连 CDP，返回 {ev, rpc, close}。ev(expression) 走 Runtime.evaluate（awaitPromise+returnByValue） */
export async function cdp(port) {
  const wsUrl = await getPageWs(port);
  const ws = new WebSocket(wsUrl);
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id && pending.has(m.id)) {
      pending.get(m.id).resolve(m.result ?? m);
      pending.delete(m.id);
    }
  };
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await rpc("Runtime.enable");
  const ev = async (expression) => {
    const r = await rpc("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __exception: JSON.stringify(r.exceptionDetails).slice(0, 800) };
    return r.result?.value;
  };
  return { ev, rpc, close: () => ws.close() };
}

/** 通过 CDP 调前端 sync-service（vite 裸路径 import = app 同实例模块图） */
export async function cdpSyncRun(port) {
  const c = await cdp(port);
  try {
    return await c.ev(
      `import('/src/services/sync-service.ts').then(m => m.syncRunNow().then(r => JSON.stringify(r)).catch(e => 'ERR:' + String(e)))`,
    );
  } finally {
    c.close();
  }
}

export function saveEvidence(name, data) {
  ensureEvidenceDir();
  const p = path.join(EVIDENCE_DIR, name);
  fs.writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data, null, 2));
  console.log(`[evidence] ${p}`);
}
