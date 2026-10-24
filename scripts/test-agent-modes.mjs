// Task 8：全局论文 extras、按角色默认范围、New/Legacy 二态与提示词说明书契约。
// 运行：node scripts/test-agent-modes.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "packages/app/src");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
if (!esbuildPkg) {
  console.error("FAIL 未找到 esbuild");
  process.exit(1);
}
const esbuild = await import(pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href);

const outDir = mkdtempSync(join(tmpdir(), "agent-modes-"));
process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));
const fixtureApp = join(outDir, "fixture-app");
const PAPER_A = "paper-a";
const PAPER_B = "paper-b";
const BOOK = "book-a";
mkdirSync(join(fixtureApp, "books", PAPER_A, "images"), { recursive: true });
mkdirSync(join(fixtureApp, "books", PAPER_B, "images"), { recursive: true });
writeFileSync(
  join(fixtureApp, "books", PAPER_A, "paper.md"),
  "---\ntitle: Paper A\n---\n# Methods\n![Figure 1](images/fig-a.png)\nFigure 1. Alpha figure\n# References\n[1] Alpha citation\n",
);
writeFileSync(
  join(fixtureApp, "books", PAPER_B, "paper.md"),
  "---\ntitle: Paper B\n---\n# Methods\n![Figure 1](images/fig-b.png)\nFigure 1. Beta figure\n# References\n[1] Beta citation\n",
);
globalThis.__SAGEREAD_AGENT_MODE_TEST__ = { appData: fixtureApp, hasVector: true };
globalThis.window = {};

const tsPath = (path) => path.replace(/\\/g, "/");
const stubTool = `const makeTool = (description) => ({ description, execute: async () => ({ description }) });\n`;
const centralNames = [
  "askAppHelpTool",
  "convertPdfTool",
  "downloadFileTool",
  "editFileTool",
  "exportNotesTool",
  "extractZipTool",
  "httpRequestTool",
  "importBookTool",
  "importFontTool",
  "importPaperTool",
  "manageBookTool",
  "manageMcpTool",
  "managePaperFoldersTool",
  "managePreferencesTool",
  "manageSecretsTool",
  "manageSkillTool",
  "manageSyncTool",
  "manageTagsTool",
  "manageThreadsTool",
  "processPaperTool",
  "runCommandTool",
  "searchFilesTool",
  "switchModelTool",
  "translateBookTool",
  "trashManagerTool",
  "vectorizeBookTool",
  "writeFileTool",
];
const centralStub = [
  stubTool,
  ...centralNames.map((name) => `export const ${name} = makeTool(${JSON.stringify(name)});`),
  `export { readLocalFileTool } from "${tsPath(join(src, "ai/tools/central/read-local-file.ts"))}";`,
  `export { searchDevDocsTool } from "${tsPath(join(src, "ai/tools/central/search-dev-docs.ts"))}";`,
].join("\n");
const indexFactoryNames = [
  "createGetCitationGraphTool",
  "createPaperContextTool",
  "createPaperFullTool",
  "createPaperInfoTool",
  "createPaperSectionTool",
  "createPaperTocTool",
  "createRagContextTool",
  "createRagRangeTool",
  "createRagSearchTool",
  "createRagTocTool",
  "createReadBookSectionTool",
];
const indexToolNames = [
  "getBooksTool",
  "getReadingStatsTool",
  "getSkillsTool",
  "mindmapTool",
  "notesTool",
  "readImageTool",
  "viewImagesTool",
  "webSearchTool",
];
const indexStub = [
  stubTool,
  ...indexFactoryNames.map(
    (name) => `export const ${name} = (...args) => makeTool(${JSON.stringify(name)});`,
  ),
  `export const createPaperSearchTool = (...args) => {
    globalThis.__SAGEREAD_AGENT_MODE_TEST__.paperSearchArgs = args;
    return makeTool("createPaperSearchTool");
  };`,
  ...indexToolNames.map((name) => `export const ${name} = makeTool(${JSON.stringify(name)});`),
  `export { sciverseSearchTool } from "${tsPath(join(src, "ai/tools/sciverse-search.ts"))}";`,
  `export { createGetCitationsTool, createGetFiguresTool } from "${tsPath(join(src, "ai/tools/paper/paper-extras.ts"))}";`,
].join("\n");
const documentStub = (name) => `${stubTool}export const ${name} = () => makeTool(${JSON.stringify(name)});`;

const STUBS = {
  "@tauri-apps/api/path": "export const appDataDir = async () => globalThis.__SAGEREAD_AGENT_MODE_TEST__.appData;",
  "@tauri-apps/api/core": `export async function invoke(command) {
    if (command === "plugin:epub|paper_index_status") return { indexed: false, chunkCount: 0 };
    throw new Error("unexpected invoke: " + command);
  }`,
  "@tauri-apps/plugin-fs": `
    import { existsSync } from "node:fs";
    import { readFile } from "node:fs/promises";
    export const exists = async (path) => existsSync(path);
    export const readTextFile = (path) => readFile(path, "utf8");
  `,
  "@/lib/tauri-storage": `export const tauriStorage = {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  };`,
  "@/utils/mobile": "export const isMobile = false;",
  "@/store/library-store": `export const useLibraryStore = {
    getState: () => ({ booksWithStatus: [] }),
  };`,
  "@/store/llama-store": `export const useLlamaStore = {
    getState: () => ({ hasVectorCapability: () => globalThis.__SAGEREAD_AGENT_MODE_TEST__.hasVector }),
  };`,
  "@/store/sciverse-store": `export const useSciverseStore = {
    getState: () => ({ enabled: false }),
  };`,
  "@/services/prompt-preset-service": `
    export const getActivePresetContent = async () => null;
    export const migrateLegacyReaderBaseIfNeeded = async () => {};
  `,
  "@/services/skill-service": `
    export const getSkills = async () => [];
    export const skillAppliesTo = () => false;
  `,
  "@/services/global-theme-service": "export const listGlobalThemes = async () => [];",
  "@/services/manual-service": `
    export const WIKI_BOOK_ID = "wiki";
    export const ensureWikiIndex = async () => ({ message: "up-to-date" });
    export const keywordSearchWiki = async () => [];
    export const searchCorpus = async () => [];
  `,
  "@/utils/model": "export const getCurrentVectorModelConfig = async () => { throw new Error('not used'); };",
  "@/pages/paper-reader/paper-metadata": `
    export const parsePaperMarkdown = (raw) => ({ metadata: {}, body: raw });
    export const normalizeAuthors = (author) => Array.isArray(author) ? author.map((item) => typeof item === "string" ? item : item.name).filter(Boolean) : [];
  `,
  "@/ai/utils/tool-catalog-audit": "export const auditToolCatalogCall = () => {};",
  "@/ai/utils/tool-image-cache": "export const cacheToolImages = () => {};",
  "@/ai/utils/tool-result-slimming": `
    export const imagePlaceholderText = () => "image";
    export const toolImageBytesFromNode = () => null;
  `,
};

const entry = join(outDir, "agent-modes-entry.ts");
const outfile = join(outDir, "agent-modes.mjs");
writeFileSync(
  entry,
  [
    `export * as registry from "${tsPath(join(src, "ai/tools/registry.ts"))}";`,
    `export * as paperExtras from "${tsPath(join(src, "ai/tools/paper/paper-extras.ts"))}";`,
    `export * as scopeConstants from "${tsPath(join(src, "constants/retrieval-scope.ts"))}";`,
    `export { resolveRetrievalScope, isDocInRetrievalScope } from "${tsPath(join(src, "ai/tools/document/shared.ts"))}";`,
    `export { getDocumentToolMode } from "${tsPath(join(src, "ai/tools/document/mode.ts"))}";`,
    `export { useAgentSettingsStore } from "${tsPath(join(src, "store/agent-settings-store.ts"))}";`,
    `export { useRetrievalScopeStore } from "${tsPath(join(src, "store/retrieval-scope-store.ts"))}";`,
    `export { buildLibraryGuide } from "${tsPath(join(src, "ai/prompts/library-guide.ts"))}";`,
    `export { buildPrompt, buildReadingPrompt } from "${tsPath(join(src, "constants/prompt.ts"))}";`,
    `export { buildPaperPrompt } from "${tsPath(join(src, "constants/paper-prompt.ts"))}";`,
    `export { buildCentralPrompt } from "${tsPath(join(src, "constants/central-prompt.ts"))}";`,
    `export { buildLazyToolset } from "${tsPath(join(src, "ai/tools/lazy-toolset.ts"))}";`,
    `export { formatPositionForPrompt } from "${tsPath(join(src, "services/reading-position/position-service.ts"))}";`,
  ].join("\n"),
);
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  alias: { "@": src },
  nodePaths: [join(root, "packages/app/node_modules")],
  plugins: [
    {
      name: "agent-mode-test-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (STUBS[args.path]) return { path: args.path, namespace: "agent-stub" };
          if (!args.importer.endsWith("registry.ts")) return null;
          if (args.path === "./central") return { path: "central", namespace: "registry-stub" };
          if (args.path === "./index") return { path: "index", namespace: "registry-stub" };
          if (args.path === "./document/get-document-info") return { path: "getDocumentInfo", namespace: "registry-stub" };
          if (args.path === "./document/read-document") return { path: "readDocument", namespace: "registry-stub" };
          if (args.path === "./document/search-library") return { path: "searchLibrary", namespace: "registry-stub" };
          if (args.path === "./manage-notes") return { path: "manageNotes", namespace: "registry-stub" };
          if (args.path === "./read-thread") return { path: "readThread", namespace: "registry-stub" };
          if (args.path === "./reading-position") return { path: "readingPosition", namespace: "registry-stub" };
          return null;
        });
        build.onLoad({ filter: /.*/, namespace: "agent-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "js",
        }));
        build.onLoad({ filter: /.*/, namespace: "registry-stub" }, (args) => {
          if (args.path === "central") return { contents: centralStub, loader: "js", resolveDir: root };
          if (args.path === "index") return { contents: indexStub, loader: "js", resolveDir: root };
          if (args.path === "readingPosition") {
            return {
              contents: `${stubTool}export const createGetReadingPositionTool = () => makeTool("getReadingPosition");
                export const createReadAtReadingPositionTool = () => makeTool("readAtReadingPosition");`,
              loader: "js",
            };
          }
          const factoryName = args.path === "manageNotes" ? "createManageNotesTool" : args.path === "readThread" ? "createReadThreadTool" : `create${args.path[0].toUpperCase()}${args.path.slice(1)}Tool`;
          return { contents: documentStub(factoryName), loader: "js" };
        });
      },
    },
  ],
});
const mod = await import(pathToFileURL(outfile).href);

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    const suffix = detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
    console.log(`  FAIL ${name}${suffix}`);
  }
}
function setOverride(value) {
  if (value === undefined) delete globalThis.window.__SAGEREAD_DOC_TOOL_MODE__;
  else globalThis.window.__SAGEREAD_DOC_TOOL_MODE__ = value;
}
function setStoredMode(value) {
  mod.useAgentSettingsStore.setState({ documentToolMode: value });
}
async function errorOf(tool, args) {
  try {
    await tool.execute({ reasoning: "Task 8", ...args }, { toolCallId: `t8-${Math.random()}`, messages: [] });
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

console.log("[1] 按角色默认范围与持久化边界");
{
  const defaults = mod.scopeConstants.defaultRetrievalScope;
  check("defaultRetrievalScope(reader)=current", defaults?.("reader") === "current", typeof defaults);
  check("defaultRetrievalScope(paper)=library", defaults?.("paper") === "library", defaults?.("paper"));
  check("defaultRetrievalScope(central)=all", defaults?.("central") === "all", defaults?.("central"));
  check("reader 缺省范围=current", mod.resolveRetrievalScope({ scope: "reader", currentId: BOOK }) === "current");
  check("paper 缺省范围=library", mod.resolveRetrievalScope({ scope: "paper", currentId: PAPER_A }) === "library");
  check("central 缺省范围=all", mod.resolveRetrievalScope({ scope: "central" }) === "all");
  check(
    "paper 缺省 library 允许其它论文",
    mod.isDocInRetrievalScope({ kind: "paper", id: PAPER_B }, { scope: "paper", currentId: PAPER_A }),
  );
  check(
    "paper 显式 current 不回填成 library",
    mod.resolveRetrievalScope({ scope: "paper", currentId: PAPER_A, retrievalScope: "current" }) === "current",
  );
  const options = mod.useRetrievalScopeStore.persist.getOptions();
  const current = mod.useRetrievalScopeStore.getState();
  const saved = options.merge({ scopes: { [`paper:${PAPER_A}`]: "current" } }, current);
  check(
    "scopes merge 保留显式 current 且不新增默认键",
    JSON.stringify(saved.scopes) === JSON.stringify({ [`paper:${PAPER_A}`]: "current" }),
    saved.scopes,
  );
  const empty = options.merge({ scopes: {} }, current);
  check("空 scopes 不做数据迁移/默认回填", Object.keys(empty.scopes).length === 0, empty.scopes);
}

console.log("[2] agent-settings v3、二态归一与 registry 矩阵");
{
  const options = mod.useAgentSettingsStore.persist.getOptions();
  check("agent-settings persist version=3", options.version === 3, options.version);
  for (const version of [0, 1, 2]) {
    check(`v${version} Both 迁移为 new`, options.migrate({ documentToolMode: "both" }, version).documentToolMode === "new");
    check(`v${version} 非法模式迁移为 new`, options.migrate({ documentToolMode: "invalid" }, version).documentToolMode === "new");
  }
  check("migrate 保留显式 legacy", options.migrate({ documentToolMode: "legacy" }, 2).documentToolMode === "legacy");
  const current = mod.useAgentSettingsStore.getState();
  check("merge 归一旧 Both=new", options.merge({ documentToolMode: "both" }, current).documentToolMode === "new");
  check("merge 保留显式 legacy", options.merge({ documentToolMode: "legacy" }, current).documentToolMode === "legacy");
  check("merge 保留显式 new", options.merge({ documentToolMode: "new" }, current).documentToolMode === "new");

  setStoredMode("new");
  setOverride("new");
  const newPaper = mod.registry.getToolsForScope("paper", { paperId: PAPER_A });
  check("New paper 只暴露新原语", !!newPaper.readDocument && !newPaper.readPaperSection, Object.keys(newPaper));
  check("New paper 保留 extras", !!newPaper.getFigures && !!newPaper.getCitations);
  const newReader = mod.registry.getToolsForScope("reader", { bookId: BOOK });
  check("Reader 不注册 getFigures/getCitations", !newReader.getFigures && !newReader.getCitations);
  check("New central 注册 getFigures/getCitations", (() => {
    const tools = mod.registry.getToolsForScope("central");
    return !!tools.getFigures && !!tools.getCitations;
  })());
  const newDescriptions = mod.registry.getToolDescriptions("paper").join("\n");
  check("getToolDescriptions(New) 只推荐新读工具", newDescriptions.includes("- readDocument:") && !newDescriptions.includes("- readPaperSection:"), newDescriptions);
  const newCentralDescriptions = mod.registry.getToolDescriptions("central").join("\n");
  check("getToolDescriptions(New central) 包含 extras", newCentralDescriptions.includes("- getFigures:") && newCentralDescriptions.includes("- getCitations:"), newCentralDescriptions);

  setOverride("legacy");
  const legacyPaper = mod.registry.getToolsForScope("paper", { paperId: PAPER_A });
  check("Legacy paper 只暴露旧读工具", !legacyPaper.readDocument && !!legacyPaper.readPaperSection, Object.keys(legacyPaper));
  const legacyDescriptions = mod.registry.getToolDescriptions("paper").join("\n");
  check("getToolDescriptions(Legacy) 不推荐新原语", legacyDescriptions.includes("- readPaperSection:") && !legacyDescriptions.includes("- readDocument:"), legacyDescriptions);
  const legacyDefaultScope = mod.registry.getToolsForScope("paper", { paperId: PAPER_A });
  check(
    "Legacy paper 缺省 paperScopeIds=null",
    !!legacyDefaultScope.paperSearch && globalThis.__SAGEREAD_AGENT_MODE_TEST__.paperSearchArgs?.[0] === null,
    globalThis.__SAGEREAD_AGENT_MODE_TEST__.paperSearchArgs,
  );
  const legacyPaperScopeIds = mod.scopeConstants.legacyPaperScopeIds;
  check(
    "真实 Legacy scope mapper：current→[paperId]",
    JSON.stringify(legacyPaperScopeIds?.("current", PAPER_A)) === JSON.stringify([PAPER_A]),
    legacyPaperScopeIds?.("current", PAPER_A),
  );
  check("真实 Legacy scope mapper：library→null", legacyPaperScopeIds?.("library", PAPER_A) === null, legacyPaperScopeIds?.("library", PAPER_A));
  check("真实 Legacy scope mapper：all→null", legacyPaperScopeIds?.("all", PAPER_A) === null, legacyPaperScopeIds?.("all", PAPER_A));
  check("Legacy paper 保留 extras", !!legacyPaper.getFigures && !!legacyPaper.getCitations);
  check("Legacy central 也注册 getFigures/getCitations", (() => {
    const tools = mod.registry.getToolsForScope("central");
    return !!tools.getFigures && !!tools.getCitations;
  })());

  setStoredMode("legacy");
  for (const invalid of ["both", "invalid"]) {
    setOverride(invalid);
    check(`window override ${invalid} → new`, mod.getDocumentToolMode() === "new", mod.getDocumentToolMode());
    const tools = mod.registry.getToolsForScope("paper", { paperId: PAPER_A });
    check(`override ${invalid} 不产生 New+Legacy 并集`, !!tools.readDocument && !tools.readPaperSection, Object.keys(tools));
  }
  setOverride(undefined);
  setStoredMode("invalid");
  check("非法 persisted mode → new", mod.getDocumentToolMode() === "new", mod.getDocumentToolMode());
  const invalidTools = mod.registry.getToolsForScope("paper", { paperId: PAPER_A });
  check("非法 persisted mode 不产生并集", !!invalidTools.readDocument && !invalidTools.readPaperSection, Object.keys(invalidTools));
  setStoredMode("legacy");
  check("显式 persisted legacy 保留", mod.getDocumentToolMode() === "legacy", mod.getDocumentToolMode());
  setStoredMode("new");
}

console.log("[3] paper extras 的真实 doc 解析、报错与范围门禁");
{
  const centralCtx = { scope: "central" };
  for (const [name, factory] of [
    ["getCitations", mod.paperExtras.createGetCitationsTool],
    ["getFigures", mod.paperExtras.createGetFiguresTool],
  ]) {
    const central = factory(undefined, centralCtx);
    const missing = await errorOf(central, {});
    check(`central ${name} 缺 doc 给可执行错误`, /doc\s*=\s*paper:/.test(missing), missing);
    const book = await errorOf(central, { doc: `book:${BOOK}` });
    check(`central ${name} 拒绝 book doc`, /paper:<|仅支持论文|必须是 paper/.test(book), book);
    const result = await central.execute(
      { reasoning: "Task 8", doc: `paper:${PAPER_A}` },
      { toolCallId: `central-${name}`, messages: [] },
    ).catch((error) => ({ __error: String(error) }));
    check(`central ${name} 显式 paper doc 成功`, !result.__error && (name === "getCitations" ? result.found === true : result.total === 1), result);
  }
  setOverride("new");
  const registeredCentral = mod.registry.getToolsForScope("central");
  for (const name of ["getCitations", "getFigures"]) {
    const tool = registeredCentral[name];
    const result = tool
      ? await tool.execute(
          { reasoning: "Task 8 registry", doc: `paper:${PAPER_A}` },
          { toolCallId: `registry-central-${name}`, messages: [] },
        ).catch((error) => ({ __error: String(error) }))
      : { __error: "not registered" };
    check(
      `registry central ${name} 显式 paper doc 端到端成功`,
      !result.__error && (name === "getCitations" ? result.found === true : result.total === 1),
      result,
    );
  }
  for (const [name, factory] of [
    ["getCitations", mod.paperExtras.createGetCitationsTool],
    ["getFigures", mod.paperExtras.createGetFiguresTool],
  ]) {
    const bound = factory(PAPER_A, { scope: "paper", currentId: PAPER_A, retrievalScope: "current" });
    const result = await bound.execute({ reasoning: "Task 8" }, { toolCallId: `paper-${name}`, messages: [] });
    check(`paper ${name} 省略 doc 仍读绑定论文`, name === "getCitations" ? result.found === true : result.figures[0]?.image.includes("fig-a"), result);
    const outside = await errorOf(bound, { doc: `paper:${PAPER_B}` });
    check(`paper ${name} 显式 doc 走范围门禁`, /超出用户划定的检索范围/.test(outside), outside);
  }
}

console.log("[4] 提示词默认范围与未索引互补口径");
{
  setOverride("new");
  globalThis.__SAGEREAD_AGENT_MODE_TEST__.hasVector = false;
  const paperDefault = await mod.buildPaperPrompt({ agentScope: "paper", activeBookId: PAPER_A });
  check("paper prompt 缺省 retrievalScope=library", paperDefault.includes("retrievalScope=library"), paperDefault.match(/retrievalScope=\w+/)?.[0]);
  check("paper New 提示关键词/标题回退", paperDefault.includes("关键词/标题"), "");
  check("paper New 不再称 searchLibrary 不可用", !paperDefault.includes("searchLibrary 不可用"), "");
  const paperCurrent = await mod.buildPaperPrompt({ agentScope: "paper", activeBookId: PAPER_A, retrievalScope: "current" });
  check("paper prompt 显式 current 保留", paperCurrent.includes("retrievalScope=current"), paperCurrent.match(/retrievalScope=\w+/)?.[0]);
  const readerDefault = await mod.buildReadingPrompt({ agentScope: "reader", activeBookId: BOOK });
  check("reader prompt 缺省 retrievalScope=current", readerDefault.includes("retrievalScope=current"), readerDefault.match(/retrievalScope=\w+/)?.[0]);
  check("reader New 未索引提示关键词/标题回退", readerDefault.includes("关键词/标题"), "");
  check("reader New 不再禁用未索引 searchLibrary", !readerDefault.includes("不能用 searchLibrary 检索本书"), "");
  const fullPrompt = await mod.buildPrompt({ agentScope: "reader", activeBookId: BOOK });
  check("library guide 说明回退与目录读取互补", fullPrompt.includes("关键词/标题") && fullPrompt.includes("互补"), "");
  check("library guide 不再称未索引只能直读", !fullPrompt.includes("只能按目录/原文读取"), "");
  const central = await mod.buildCentralPrompt();
  check("central New 提示 extras 必须显式 paper doc", central.includes("getFigures") && central.includes("getCitations") && central.includes("doc=paper:"), "");
  check("central New 提示未索引关键词/标题回退", central.includes("关键词/标题"), "");
  const centralSearchLine = central.split("\n").find((line) => line.startsWith("• searchLibrary：")) || "";
  check("central New 无向量仍提供关键词回退且不要求向量", centralSearchLine.includes("关键词/标题") && !/需.*向量/.test(centralSearchLine), centralSearchLine);
  const centralFull = await mod.buildPrompt({ agentScope: "central" });
  check("central 完整提示不再称只启用三个文档工具", !centralFull.includes("当前只启用 readDocument / getDocumentInfo / searchLibrary"), "");
  const positionSnapshot = {
    scope: "paper",
    docId: PAPER_A,
    label: "Methods",
    labelSource: "toc",
    mdRelPath: "paper.md",
    mdLength: 1000,
    charOffset: 100,
    percentInDoc: 10,
    chunkRange: null,
    chunkTotal: null,
    overallPercent: 10,
    spineIndex: null,
    spineTotal: null,
    cfi: null,
  };
  const newPosition = mod.formatPositionForPrompt(positionSnapshot, "new");
  check("New 动态位置段推荐 readDocument(position=true)", newPosition.includes("readDocument(position=true)") && !newPosition.includes("readAtReadingPosition"), newPosition);
  const legacyPosition = mod.formatPositionForPrompt(positionSnapshot, "legacy");
  check("Legacy 动态位置段保留 readAtReadingPosition", legacyPosition.includes("readAtReadingPosition") && !legacyPosition.includes("readDocument(position=true)"), legacyPosition);
  for (const rel of ["packages/app/src/ai/custom-chat-transport.ts", "packages/app/src/ai/tools/reading-position.ts"]) {
    const source = readFileSync(join(root, rel), "utf8");
    check(`${rel} 按 getDocumentToolMode 生成位置指引`, source.includes("formatPositionForPrompt(snapshot, getDocumentToolMode())"), "");
  }
  setOverride("legacy");
  const readerLegacy = await mod.buildPrompt({ agentScope: "reader", activeBookId: BOOK });
  const readerLegacyTools = mod.registry.getToolsForScope("reader", { bookId: BOOK });
  check("Reader Legacy 不推荐未注册的 paperSearch", !readerLegacyTools.paperSearch && !readerLegacy.includes("paperSearch"), readerLegacy.match(/.{0,50}paperSearch.{0,100}/g) || "no paperSearch");
  const legacyGuide = await mod.buildLibraryGuide();
  check(
    "Legacy library guide 用角色中性原文工具口径",
    !legacyGuide.includes("getDocumentInfo") &&
      !legacyGuide.includes("readDocument") &&
      !legacyGuide.includes("searchLibrary") &&
      !legacyGuide.includes("readBookSection") &&
      !legacyGuide.includes("readPaperSection") &&
      !legacyGuide.includes("paperSearch") &&
      legacyGuide.includes("原文读取工具"),
    legacyGuide,
  );
  const legacyCentral = await mod.buildCentralPrompt();
  const legacyCentralTools = mod.registry.getToolsForScope("central");
  check("central Legacy/no-vector 实际不注册 paperSearch/paperContext", !legacyCentralTools.paperSearch && !legacyCentralTools.paperContext, Object.keys(legacyCentralTools));
  check(
    "central Legacy/no-vector 不推荐未注册检索工具并说明限制",
    !legacyCentral.includes("• paperSearch：") &&
      !legacyCentral.includes("旧模式用 paperSearch/paperContext") &&
      /未配置嵌入模型.*(?:不可用|未注册)/.test(legacyCentral),
    legacyCentral.match(/.{0,60}(?:paperSearch|未配置嵌入模型).{0,120}/g) || "no matching policy",
  );
  check("central Legacy 同样提示 extras 显式 paper doc", legacyCentral.includes("getFigures") && legacyCentral.includes("getCitations") && legacyCentral.includes("doc=paper:"), "");
  const legacyPaperPrompt = await mod.buildPaperPrompt({ agentScope: "paper", activeBookId: PAPER_A });
  check(
    "Legacy paper 区分通用跨文档限制与圈内 extras 显式 doc",
    mod.resolveRetrievalScope({ scope: "paper", currentId: PAPER_A }) === "library" &&
      !legacyPaperPrompt.includes("之外的直读也做不到") &&
      /getFigures\/getCitations[^。\n]*doc=paper:/.test(legacyPaperPrompt),
    legacyPaperPrompt.match(/.{0,60}(?:之外的直读|getFigures\/getCitations|retrievalScope=).{0,140}/g) || "no scope text",
  );
  setOverride("new");
  globalThis.__SAGEREAD_AGENT_MODE_TEST__.hasVector = true;
}

console.log("[5] describeTool 不推荐当前模式/角色不存在的工具");
{
  setOverride("new");
  const centralTools = mod.registry.getToolsForScope("central");
  const lazy = mod.buildLazyToolset(centralTools);
  for (const name of ["sciverseSearch", "readLocalFile", "searchDevDocs"]) {
    const description = (await lazy.describeTool.execute({ tool: name }, { toolCallId: `describe-${name}`, messages: [] })).description;
    check(`New central ${name} 不推荐 Legacy 工具`, !/ragSearch|paperSearch|readPaperSection/.test(description), description.slice(0, 300));
  }
  const directExtras = mod.buildLazyToolset({ getCitations: mod.paperExtras.createGetCitationsTool(PAPER_A) });
  const citationDescription = (await directExtras.describeTool.execute({ tool: "getCitations" }, { toolCallId: "describe-citations", messages: [] })).description;
  check("getCitations 说明书不固定推荐 readPaperSection", !citationDescription.includes("readPaperSection"), citationDescription.slice(-260));
  setOverride("legacy");
  globalThis.__SAGEREAD_AGENT_MODE_TEST__.hasVector = false;
  const legacyNoVectorTools = mod.registry.getToolsForScope("central");
  check(
    "central Legacy/no-vector describeTool 前置：无通用库内检索/阅读工具",
    !legacyNoVectorTools.paperSearch && !legacyNoVectorTools.paperContext && !legacyNoVectorTools.readDocument && !legacyNoVectorTools.searchLibrary,
    Object.keys(legacyNoVectorTools),
  );
  const legacyCentral = mod.buildLazyToolset(legacyNoVectorTools);
  for (const name of ["sciverseSearch", "readLocalFile", "searchDevDocs", "getCitations"]) {
    const description = (await legacyCentral.describeTool.execute({ tool: name }, { toolCallId: `describe-legacy-no-vector-${name}`, messages: [] })).description;
    check(
      `central Legacy/no-vector ${name} 不假设存在库内回退工具`,
      !/当前助手|readDocument|searchLibrary|readPaperSection|paperSearch|ragSearch/.test(description),
      description.slice(-360),
    );
  }
  globalThis.__SAGEREAD_AGENT_MODE_TEST__.hasVector = true;
}

console.log("[6] UI/脚本源码契约（保留 direct+directory 的 both 语义）");
{
  const read = (rel) => readFileSync(join(root, rel), "utf8");
  const settings = read("packages/app/src/components/settings/agent-settings.tsx");
  const options = settings.slice(settings.indexOf("const DOC_TOOL_MODE_OPTIONS"), settings.indexOf("const SCOPE_OPTIONS"));
  check("文档模式 UI 只有 New/Legacy 两项", (options.match(/value: "(?:new|legacy)"/g) || []).length === 2 && !options.includes('value: "both"'), options);
  const registry = read("packages/app/src/ai/tools/registry.ts");
  check("registry 使用显式 === 模式判断", registry.includes('docToolMode === "new"') && registry.includes('docToolMode === "legacy"') && !/docToolMode !== "(?:new|legacy)"/.test(registry), "");
  const paperPanel = read("packages/app/src/pages/papers/paper-chat-panel.tsx");
  check(
    "paper panel 使用真实 legacyPaperScopeIds mapper 而非自测输入",
    paperPanel.includes("legacyPaperScopeIds(retrievalScope, paperId)") && !paperPanel.includes('return retrievalScope === "current" ? [paperId] : null'),
    paperPanel.slice(paperPanel.indexOf("const paperScopeIds"), paperPanel.indexOf("const paperScopeIds") + 240),
  );
  for (const rel of ["packages/app/src/ai/tools/document/mode.ts", "packages/app/src/store/agent-settings-store.ts"]) {
    const source = read(rel);
    check(`${rel} DocumentToolMode 类型删除 Both`, !source.includes('DocumentToolMode = "both"'), "");
  }
  const vision = read("scripts/cdp-verify-vision-4images.mjs");
  check("视觉 both=direct+directory 保留", vision.includes('MODE === "both"') && vision.includes('label: "directory"'), "");
  check("视觉 direct profile=new + disableDirectory", (vision.match(/label: "direct", docMode: "new", disableDirectory: true/g) || []).length === 2, "");
  check("视觉 direct profile 不再用 DocumentToolMode Both", !vision.includes('docMode: "both"'), "");
  const probe = read("scripts/cdp-verify-vision-probe.mjs");
  check("单图视觉探针缺省 DocumentToolMode=new", !probe.includes(': "both"') && probe.includes(': "new"'), "");
  const baseline = read("evals/runner/run-baseline.mjs");
  check("baseline 恢复既有文档模式 override", baseline.includes("hadDocToolMode") && baseline.includes("previousDocToolMode"), "");
}

setOverride(undefined);
setStoredMode("new");
console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("PASS agent-modes 真实模式/范围/工具契约");
