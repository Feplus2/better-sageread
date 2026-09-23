// 模型表三处副本一致性检查（维护工作流第 0 步/收尾步，见 docs/model-maps-maintenance.md）
// ① site/maps/*.json（远程热更新源）== packages/app/src/ai/providers/maps/*.json（打包兜底），逐字节
// ② Books_Converter 的 vision-map 移植（gui/src/lib/vision-map.ts，若该仓库在邻侧路径存在）：
//    键集合与布尔值须与 SageRead 视觉表一致（BC 只移植视觉表；思考表是端点级启发式，不在此校验）
// ③ 两张 JSON 形状校验（非空、updatedAt 可解析、值类型合法）
// 运行：node scripts/maps-sync-check.mjs；退出码 0=全一致，1=有漂移
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";

const SG_VISION = "packages/app/src/ai/providers/maps/vision-map.json";
const SG_REASONING = "packages/app/src/ai/providers/maps/reasoning-map.json";
const SITE_VISION = "site/maps/vision-map.json";
const SITE_REASONING = "site/maps/reasoning-map.json";
const BC_VISION_TS = "F:/MyProjects/Books_Converter/gui/src/lib/vision-map.ts";

let problems = 0;
const bad = (msg) => {
  problems++;
  console.log(`DRIFT ${msg}`);
};
const ok = (msg) => console.log(`SYNC  ${msg}`);

// ① 逐字节一致
for (const [a, b] of [
  [SITE_VISION, SG_VISION],
  [SITE_REASONING, SG_REASONING],
]) {
  if (readFileSync(a, "utf8") === readFileSync(b, "utf8")) ok(`${a} == ${b}`);
  else bad(`${a} 与 ${b} 内容不一致`);
}

// ③ 形状校验
const vision = JSON.parse(readFileSync(SG_VISION, "utf8"));
const reasoning = JSON.parse(readFileSync(SG_REASONING, "utf8"));
const dateOk = (u) => typeof u === "string" && Number.isFinite(Date.parse(u));
if (!dateOk(vision.updatedAt) || !dateOk(reasoning.updatedAt)) bad("updatedAt 缺失/不可解析");
else ok(`updatedAt vision=${vision.updatedAt} reasoning=${reasoning.updatedAt}`);
if (!Object.keys(vision.models).length || !Object.keys(reasoning.models).length) bad("空表");
if (!Object.values(vision.models).every((v) => typeof v === "boolean")) bad("vision 表存在非布尔行");
const TRANSPORTS = new Set(["effort", "budget", "switch"]);
for (const [k, c] of Object.entries(reasoning.models)) {
  if (typeof c.alwaysOn !== "boolean" || !Array.isArray(c.levels) || !TRANSPORTS.has(c.transport)) bad(`reasoning 行形状非法: ${k}`);
}
if (!problems) ok("两张 JSON 形状合法");

// ② Books_Converter 移植键值一致（仓库不在邻侧则跳过，不算漂移）
if (!existsSync(BC_VISION_TS)) {
  console.log(`SKIP   未找到 ${BC_VISION_TS}（Books_Converter 不在本机邻侧路径）`);
} else {
  const src = readFileSync(BC_VISION_TS, "utf8");
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bc = new Map();
  for (const m of src.matchAll(/^\s*(?:"([^"]+)"|([A-Za-z0-9._-]+))\s*:\s*(true|false)/gm)) {
    bc.set(m[1] ?? m[2], m[3] === "true");
  }
  const missing = Object.keys(vision.models).filter((k) => !bc.has(k));
  const extra = [...bc.keys()].filter((k) => !(k in vision.models));
  const mismatch = Object.keys(vision.models).filter((k) => bc.has(k) && bc.get(k) !== vision.models[k]);
  if (missing.length) bad(`BC 缺失行: ${missing.join(", ")}`);
  if (extra.length) bad(`BC 多出 SageRead 没有的行: ${extra.join(", ")}`);
  if (mismatch.length) bad(`BC 同键不同值: ${mismatch.join(", ")}`);
  if (!missing.length && !extra.length && !mismatch.length) ok(`Books_Converter 移植一致（${bc.size} 行）`);
}

console.log(problems ? `\n${problems} 处漂移` : "\n全部一致");
process.exit(problems ? 1 : 0);
