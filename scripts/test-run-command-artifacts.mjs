import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = join(root, "packages/app/src");
const esbuildPkg = readdirSync(join(root, "node_modules", ".pnpm")).find((d) => d.startsWith("esbuild@"));
assert.ok(esbuildPkg);
const esbuild = await import(
  pathToFileURL(join(root, "node_modules", ".pnpm", esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);
const dom = new JSDOM("<!doctype html>", { url: "http://localhost/" });
Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.window.localStorage, configurable: true });
const changes = [{ path: "F:/ws/out.csv", kind: "created", verified: true }];
const calls = [];
dom.window.__TAURI_INTERNALS__ = {
  invoke: async (command, args) => {
    if (String(command).includes("app_config_dir")) return join(tmpdir(), "run-command-artifacts-config");
    if (command === "agent_run_command") {
      calls.push(args);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false, changes };
    }
    return null;
  },
};
const outDir = mkdtempSync(join(tmpdir(), "run-command-artifacts-"));
const entry = join(outDir, "entry.ts");
const outfile = join(outDir, "bundle.mjs");
writeFileSync(
  entry,
  `export { runCommandTool } from "${join(src, "ai/tools/central/run-command.ts").replace(/\\/g, "/")}";`,
);
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "silent",
});
const { runCommandTool } = await import(pathToFileURL(outfile).href);
let passed = 0;
let failed = 0;
async function test(name, run) {
  try {
    await run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name} — ${error instanceof Error ? error.stack : String(error)}`);
  }
}

await test("artifactPaths 通过 inputSchema 且禁止非数组", async () => {
  const valid = await runCommandTool.inputSchema.safeParseAsync({
    reasoning: "生成产物",
    command: "python make",
    artifactPaths: ["out.csv"],
  });
  assert.equal(valid.success, true);
  const invalid = await runCommandTool.inputSchema.safeParseAsync({
    reasoning: "生成产物",
    command: "python make",
    artifactPaths: "out.csv",
  });
  assert.equal(invalid.success, false);
});

await test("execute 转发 artifactPaths 并保留 verified changes", async () => {
  const result = await runCommandTool.execute({
    reasoning: "生成产物",
    command: "python make",
    artifactPaths: ["out.csv"],
  });
  assert.deepEqual(calls[0].artifactPaths, ["out.csv"]);
  assert.deepEqual(result.results.changes, changes);
});

console.log(`\n结果：${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
