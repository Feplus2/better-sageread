import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = join(root, "packages/app/src");
const esbuildPkg = readdirSync(join(root, "node_modules", ".pnpm")).find((name) => name.startsWith("esbuild@"));
assert.ok(esbuildPkg);
const esbuild = await import(
  pathToFileURL(join(root, "node_modules", ".pnpm", esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
dom.window.__TAURI_INTERNALS__ = {
  invoke: async (command) => {
    if (command === "agent_write_file") {
      return { resolved: "F:/ws/report.md", bytes: 5, created: globalThis.__created };
    }
    if (command.includes("app_data_dir") || command === "plugin:path|resolve_directory") return "F:/default";
    if (command === "plugin:fs|exists") return false;
    return null;
  },
};
const outDir = mkdtempSync(join(tmpdir(), "write-file-created-"));
const entry = join(outDir, "entry.ts");
const outfile = join(outDir, "bundle.mjs");
writeFileSync(
  entry,
  `export { writeFileTool } from "${join(src, "ai/tools/central/write-file.ts").replace(/\\/g, "/")}";`,
);
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  alias: { "@": src },
  nodePaths: [join(root, "packages/app/node_modules")],
  logLevel: "silent",
});
const { writeFileTool } = await import(pathToFileURL(outfile).href);
globalThis.__created = true;
const created = await writeFileTool.execute({
  reasoning: "新建报告",
  path: "report.md",
  content: "hello",
  rootOverride: "F:/ws",
});
assert.equal(created.results.success, true);
assert.equal(created.results.created, true, "后端的 created=true 必须保留到工具结果");
globalThis.__created = false;
const overwritten = await writeFileTool.execute({
  reasoning: "覆盖旧报告",
  path: "report.md",
  content: "hello",
  rootOverride: "F:/ws",
});
assert.equal(overwritten.results.created, false, "覆盖已有文件不能误报新建");
console.log("PASS writeFile 保留真实新建/覆盖标记");
dom.window.close();
