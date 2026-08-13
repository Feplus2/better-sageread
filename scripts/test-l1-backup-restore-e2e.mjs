// L1 服务级集成测试（backlog ⑤-7②）：双活实例 + 当前配置的 WebDAV 远端，
// 脚本化「备份 → 恢复 → 断言一致」，替代纯手工双实例 E2E。
//
// 流程：主实例(9223) syncBackupNow → dev2(9224) syncRestore + syncRestartApp（应用重启，CDP 重连）
//       → 双库对比（books/book_notes/threads/folders/paper_folders 行集 + books 目录逐文件 sha256）。
//
// 前提：
// - 双实例运行（主 9223 / dev2 9224），且两端 WebDAV 指向同一远端（脚本只读配置、不做改动）；
// - dev2 的数据会被整体覆盖重启——请确认 dev2 是可弃测试数据；
// - 恢复后 dev2 的 L2 若开启会接着增量同步，断言在重启后立即做，不受其影响。
//
// 运行：node scripts/test-l1-backup-restore-e2e.mjs
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MAIN_CDP = "http://127.0.0.1:9223/json/list";
const DEV2_CDP = "http://127.0.0.1:9224/json/list";
const MAIN_HOME = process.env.MAIN_APPDATA || "C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev";
const DEV2_HOME = process.env.DEV2_APPDATA || "C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev2";

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : "  " + detail}`);
  if (!cond) failures++;
};

async function connect(listUrl, urlMarker) {
  const pages = await (await fetch(listUrl)).json();
  const candidates = pages.filter((p) => p.type === "page" && p.url?.includes(urlMarker));
  if (!candidates.length) throw new Error(`找不到页面 ${urlMarker}`);
  // 应用重启会留下僵死 target（WS 可连但求值不应答）：逐个试，取第一个真正应答的
  for (const page of candidates) {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    try {
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      let mid = 0;
      const pending = new Map();
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      };
      const conn = {
        ws,
        call: (method, params = {}) => {
          const id = ++mid;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((r) => pending.set(id, r));
        },
        close() {
          for (const r of pending.values()) r({ result: { result: { value: null } } });
          pending.clear();
          try { ws.close(); } catch { /* 忽略 */ }
        },
      };
      const answer = await Promise.race([
        conn.call("Runtime.evaluate", { expression: "location.origin", returnByValue: true }),
        new Promise((r) => setTimeout(() => r(null), 3000)),
      ]);
      const origin = answer?.result?.result?.value;
      if (typeof origin === "string" && origin.includes(urlMarker)) return conn; // 活目标（僵死 target 的 origin 是 "null"）
      ws.close();
    } catch {
      try { ws.close(); } catch { /* 忽略 */ }
    }
  }
  throw new Error(`所有匹配 target 均不应答 ${urlMarker}`);
}
const evalJs = (conn, expression, timeout = 120000) =>
  conn
    .call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout })
    .then((r) => {
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
      return r.result?.result?.value;
    });

/** 页面上下文就绪等待（重载窗口期 location.origin 会是 "null"） */
async function waitReady(conn) {
  for (let i = 0; i < 30; i++) {
    const origin = await evalJs(conn, `location.origin`).catch(() => null);
    if (origin && origin !== "null") return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("页面上下文久未就绪");
}

// ─── 0. 双端配置一致性（只读，不改动）───
const main = await connect(MAIN_CDP, "localhost:1420");
const dev2 = await connect(DEV2_CDP, "localhost:1421");
await waitReady(main);
await waitReady(dev2);
const cfgOf = async (conn) =>
  evalJs(conn, `(async () => {
    const svc = await import(location.origin + "/src/services/sync-service.ts");
    const c = await svc.syncGetConfig();
    return c ? { url: c.url, remote_dir: c.remote_dir, username: c.username } : null;
  })()`);
const [cfgMain, cfgDev2] = [await cfgOf(main), await cfgOf(dev2)];
console.log("主端远端:", JSON.stringify(cfgMain));
console.log("dev2 远端:", JSON.stringify(cfgDev2));
if (!cfgMain || !cfgDev2 || cfgMain.url !== cfgDev2.url || cfgMain.remote_dir !== cfgDev2.remote_dir) {
  console.error("✗ 双端 WebDAV 配置不一致或未配置，终止（脚本不代为改配置）");
  process.exit(1);
}

// ─── 1. 主端备份 ───
console.log("\n[1/4] 主端备份…");
let backup = await evalJs(main, `(async () => {
  const svc = await import(location.origin + "/src/services/sync-service.ts");
  return await svc.syncBackupNow();
})()`, 600000);
let backupName = backup?.name ?? backup?.backup_name ?? backup?.backupName;
if (!backupName && backup?.status === "skipped") {
  // 哈希门控空转（无变化不传新包）→ 取远端最新既有包恢复即可
  const list = await evalJs(main, `(async () => {
    const svc = await import(location.origin + "/src/services/sync-service.ts");
    return await svc.syncListBackups();
  })()`);
  const names = (list ?? []).map((b) => b.name ?? b.backup_name ?? b).sort();
  backupName = names[names.length - 1];
  console.log("（无变化跳过上传，改用远端最新包）");
}
ok("备份完成且得名", !!backupName, JSON.stringify(backup).slice(0, 200));
console.log("备份包:", backupName);
if (!backupName) process.exit(1);

// ─── 2. dev2 恢复 + 重启 ───
console.log("\n[2/4] dev2 恢复（随后重启应用）…");
await evalJs(dev2, `(async () => {
  const svc = await import(location.origin + "/src/services/sync-service.ts");
  return await svc.syncRestore(${JSON.stringify(backupName)});
})()`, 600000);
// 触发重启应用恢复（应用退出先于应答：竞速 8s 兜底 + 发后即忘）
await Promise.race([
  evalJs(dev2, `(async () => {
    const svc = await import(location.origin + "/src/services/sync-service.ts");
    await svc.syncRestartApp();
    return 1;
  })()`, 15000).catch(() => null),
  new Promise((r) => setTimeout(r, 8000)),
]);
dev2.close();

// 等 dev2 重新上线
let dev2Up = false;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  try {
    const pages = await (await fetch(DEV2_CDP)).json();
    if (pages.find((p) => p.type === "page" && p.url?.includes("localhost:1421"))) { dev2Up = true; break; }
  } catch { /* 重启中 */ }
}
ok("dev2 重启后重新上线", dev2Up);
if (!dev2Up) process.exit(1);
// 等迁移/恢复应用完成
await new Promise((r) => setTimeout(r, 10000));

// ─── 3. 双库对比（直接读 SQLite 文件，shutdown 状态下的安静读）───
console.log("\n[3/4] 对比数据库…");
const { execFileSync } = await import("node:child_process");
const dumpTable = (dbPath, table) =>
  execFileSync("python", ["-X", "utf8", "-c", `
import sqlite3, json, sys
db = sqlite3.connect(sys.argv[1], timeout=10)
try:
    rows = db.execute(f"SELECT * FROM {sys.argv[2]} ORDER BY 1").fetchall()
    print(json.dumps(rows))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`, dbPath, table], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const mainDb = `${MAIN_HOME}/database/app.db`;
const dev2Db = `${DEV2_HOME}/database/app.db`;
for (const table of ["books", "book_notes", "threads", "folders", "paper_folders", "notes", "tags"]) {
  const a = dumpTable(mainDb, table);
  const b = dumpTable(dev2Db, table);
  // 设备本地列（如 trashed_at 以外的同步无关字段）全量比对——L1 口径是全真复制
  ok(`${table} 行集一致`, a === b, `主 ${a.length}B vs dev2 ${b.length}B`);
}

// ─── 4. books 目录逐文件哈希对比 ───
console.log("\n[4/4] 对比 books 目录…");
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const treeHash = (root) => {
  const out = {};
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(p).isDirectory()) walk(p, rel);
      else out[rel] = sha(p);
    }
  };
  walk(root, "");
  return out;
};
const mainBooks = treeHash(`${MAIN_HOME}/books`);
const dev2Books = treeHash(`${DEV2_HOME}/books`);
const missing = Object.keys(mainBooks).filter((k) => dev2Books[k] !== mainBooks[k]);
const extra = Object.keys(dev2Books).filter((k) => !(k in mainBooks));
ok("books 目录逐文件一致", missing.length === 0 && extra.length === 0,
  `缺失/不同 ${missing.length}，多出 ${extra.length}${missing[0] ? " 首缺: " + missing[0] : ""}${extra[0] ? " 首多: " + extra[0] : ""}`);

// 向量库（L1 大包项）：SQLite 文件级哈希因页面布局可能不同，比对逻辑内容（各表行数+块数）
try {
  const vecCounts = (dbPath) =>
    execFileSync("python", ["-X", "utf8", "-c", `
import sqlite3, json, sys
db = sqlite3.connect(sys.argv[1], timeout=10)
tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
counts = {}
for t in tables:
    try: counts[t] = db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
    except Exception: pass  # vec0 虚拟表无模块不可数，跳过（其影子表仍在比对内）
print(json.dumps(counts, sort_keys=True))
`, dbPath], { encoding: "utf8" }).trim();
  const vMain = vecCounts(`${MAIN_HOME}/papers/vectors.sqlite`);
  const vDev2 = vecCounts(`${DEV2_HOME}/papers/vectors.sqlite`);
  ok("vectors.sqlite 逻辑一致", vMain === vDev2, `主 ${vMain} vs dev2 ${vDev2}`);
} catch (e) {
  ok("vectors.sqlite 逻辑一致", false, String(e).slice(0, 120));
}

main.close();
console.log(`\n${failures === 0 ? "✓ L1 备份恢复一致性 E2E 通过" : `✗ ${failures} 项失败`}`);
process.exit(failures ? 1 : 0);
