import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = mkdtempSync(join(tmpdir(), "book-glossary-filter-"));
process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((entry) => entry.startsWith("esbuild@"));
if (!esbuildPkg) throw new Error("node_modules/.pnpm 下未找到 esbuild");
const esbuild = await import(
  pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);
const outfile = join(outDir, "glossary-filter.mjs");
await esbuild.build({
  entryPoints: [join(root, "packages/app/src/services/book-translation/glossary-filter.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
});
const { sanitizeGlossaryItems } = await import(pathToFileURL(outfile).href);
const filtered = sanitizeGlossaryItems([
  { src: "Quantum Field Theory", tgt: "量子场论" },
  { src: "$W^{\\pm}$", tgt: "W±" },
  { src: "$Z^0$", tgt: "Z0" },
  { src: "\\mathrm{Na^+}", tgt: "Na+" },
  { src: "Lie groups", tgt: "李群" },
  { src: "  ", tgt: "空白" },
]);
assert.deepEqual(filtered, [
  { src: "Quantum Field Theory", tgt: "量子场论" },
  { src: "Lie groups", tgt: "李群" },
]);
console.log("PASS glossary filter excludes formula-bearing terms without dropping textual terms");
