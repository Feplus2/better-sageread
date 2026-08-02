// 端到端验证：用真实译本（appdata）+ 真实嵌入端点跑 alignPaperTranslation，验证词级 64 条/片修复
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
const esbuild = await import(
  pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);

const PAPER_ID = "a27b187c6bd02d3c";
const BOOK_DIR = `C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/${PAPER_ID}`;
const TRANSLATION_PATH = `${BOOK_DIR}/translation-zh.json`;
const MARKDOWN_PATH = `${BOOK_DIR}/paper.md`;

// 真实嵌入配置（从用户 llama-store 读取，不打印）
const cfg = JSON.parse(readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/llama-store.json", "utf-8"));
const vm = cfg.state.vectorModels.find((m) => m.id === cfg.state.selectedVectorModelId) ?? cfg.state.vectorModels[0];

const stubDir = mkdtempSync(join(tmpdir(), "paper-align-e2e-"));
writeFileSync(
  join(stubDir, "stub-translation-service.mjs"),
  `import { readFileSync, writeFileSync } from "node:fs";
export async function hashBlockText(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
export async function loadPaperTranslation() {
  return JSON.parse(readFileSync(${JSON.stringify(TRANSLATION_PATH)}, "utf-8"));
}
export async function savePaperTranslation(_id, file) {
  writeFileSync(${JSON.stringify(TRANSLATION_PATH)}, JSON.stringify(file));
}
`,
);
writeFileSync(
  join(stubDir, "stub-llama-store.mjs"),
  `export const useLlamaStore = { getState: () => ({ hasVectorCapability: () => true, initializeEmbeddingService: async () => {} }) };`,
);
writeFileSync(
  join(stubDir, "stub-model.mjs"),
  `export async function getCurrentVectorModelConfig() {
  return { embeddingsUrl: ${JSON.stringify(vm.url)}, model: ${JSON.stringify(vm.modelId)}, apiKey: ${JSON.stringify(vm.apiKey)} };
}`,
);
writeFileSync(
  join(stubDir, "entry.mjs"),
  `export { alignPaperTranslation, inspectPaperAlignment } from "@/services/paper-alignment-service";`,
);

const stubPlugin = {
  name: "paper-stubs",
  setup(build) {
    build.onResolve({ filter: /^\.\/paper-translation-service$/ }, () => ({
      path: join(stubDir, "stub-translation-service.mjs"),
    }));
    build.onResolve({ filter: /^@\/store\/llama-store$/ }, () => ({ path: join(stubDir, "stub-llama-store.mjs") }));
    build.onResolve({ filter: /^@\/utils\/model$/ }, () => ({ path: join(stubDir, "stub-model.mjs") }));
    build.onResolve({ filter: /^@\/(.*)/ }, (args) => {
      const base = join(root, "packages/app/src", args.path.slice(2));
      for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, join(base, "index.ts")]) {
        if (existsSync(c)) return { path: c };
      }
      return { path: `${base}.ts` };
    });
  },
};

const outfile = join(stubDir, "bundle.mjs");
await esbuild.build({ entryPoints: [join(stubDir, "entry.mjs")], bundle: true, format: "esm", platform: "node", outfile, plugins: [stubPlugin] });
const { JSDOM } = await import("jsdom");
globalThis.document = new JSDOM("").window.document;
const { alignPaperTranslation, inspectPaperAlignment } = await import(pathToFileURL(outfile).href);

const markdown = readFileSync(MARKDOWN_PATH, "utf-8");
const before = await inspectPaperAlignment(markdown, JSON.parse(readFileSync(TRANSLATION_PATH, "utf-8")));
console.log("修复前覆盖:", JSON.stringify(before));

const t0 = Date.now();
const result = await alignPaperTranslation({
  paperId: PAPER_ID,
  markdown,
  onProgress: (p) => {
    if (p.done % 50 === 0 || p.done === p.total) console.log(`进度 ${p.done}/${p.total}`);
  },
});
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log("结果:", JSON.stringify(result));

const after = await inspectPaperAlignment(markdown, JSON.parse(readFileSync(TRANSLATION_PATH, "utf-8")));
console.log("修复后覆盖:", JSON.stringify(after));
