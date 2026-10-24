// viewImages 与 tool-guard 必须共用 image-shared 的目标归一化；真实读取行为由 cdp-test-p1-tools.mjs 覆盖。
// 运行：node scripts/test-image-target-normalization.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shared = readFileSync(join(root, "packages/app/src/ai/tools/image-shared.ts"), "utf8");
const viewImages = readFileSync(join(root, "packages/app/src/ai/tools/view-images.ts"), "utf8");

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

check(
  "image-shared 导出统一 collectImageTargets",
  /export function collectImageTargets\(paths\?: string\[\], refs\?: string\[\]\)/.test(shared),
);
check(
  "viewImages 复用统一 collectImageTargets",
  /import\s*\{[^}]*\bcollectImageTargets\b[^}]*\}\s*from\s*"\.\/image-shared"/.test(viewImages)
    && /const targets = collectImageTargets\(paths, refs\)/.test(viewImages),
);
check(
  "viewImages 不维护第二份 collector/resolver",
  !/interface ResolvedTarget|function resolveTarget\(|function collectTargets\(/.test(viewImages),
);

console.log(`结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
