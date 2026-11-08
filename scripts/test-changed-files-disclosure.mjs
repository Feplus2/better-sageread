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
const outDir = mkdtempSync(join(tmpdir(), "changed-files-disclosure-"));
const entry = join(outDir, "entry.ts");
const outfile = join(outDir, "bundle.mjs");
const posix = (path) => path.replace(/\\/g, "/");
writeFileSync(
  entry,
  `export { ChangedFilesDisclosure } from "${posix(join(src, "components/file-workspace/changed-files-disclosure.tsx"))}";
   export { default as React } from "react";
   export { renderToStaticMarkup } from "react-dom/server";`,
);
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  outfile,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  alias: { "@": src },
  nodePaths: [join(root, "packages/app/node_modules")],
  logLevel: "silent",
});
const { ChangedFilesDisclosure, React, renderToStaticMarkup } = await import(pathToFileURL(outfile).href);
const message = {
  id: "new-message",
  parts: [
    {
      type: "tool-writeFile",
      toolCallId: "new-file",
      state: "output-available",
      output: { results: { success: true, path: "F:/ws/probe.mjs", created: true } },
    },
    {
      type: "tool-present",
      toolCallId: "deliverable",
      state: "output-available",
      output: { results: { success: true, deliverable: { path: "F:/ws/README.md", description: "最终使用说明" } } },
    },
  ],
};
const otherMessage = {
  id: "other-message",
  parts: [
    {
      type: "tool-editFile",
      toolCallId: "other-turn-file",
      state: "output-available",
      output: { results: { success: true, path: "F:/ws/other-turn.md", replacements: 1 } },
    },
  ],
};
const html = renderToStaticMarkup(React.createElement(ChangedFilesDisclosure, { message, onOpenFile: () => {} }));
const document = new JSDOM(`<main id="chat-sidebar">${html}</main>`).window.document;
const section = document.querySelector('[data-region="changed-files"]');
assert.equal(section?.getAttribute("data-message-files"), "new-message");
const disclosure = section?.querySelector("[aria-expanded]");
assert.equal(disclosure?.getAttribute("aria-expanded"), "false", "每轮编辑列表应默认折叠");
assert.match(disclosure?.textContent ?? "", /已编辑 1 个文件/);
assert.equal(section?.querySelector('[data-region="new-files"]'), null, "新建文件不能自动冒充交付物");
assert.equal(section?.querySelectorAll('[data-region="presented-files"] [data-file-path]').length, 1);
assert.equal(
  section?.querySelector('[data-region="presented-files"] [data-file-path]')?.getAttribute("data-file-path"),
  "F:/ws/README.md",
);
assert.match(section?.textContent ?? "", /最终使用说明/);
assert.doesNotMatch(section?.textContent ?? "", /other-turn\.md/, "不能把另一轮的文件挂到本轮");
assert.doesNotMatch(section?.textContent ?? "", /本次新建/);
console.log("PASS 每轮编辑默认折叠、显式交付与自动新建分离、不串轮");
