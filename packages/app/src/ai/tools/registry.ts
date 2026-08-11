/**
 * 工具注册框架：按 Agent 角色（central / reader / paper）动态组装工具集。
 *
 * - central（全局助手）：shared + central 工具，拥有全局操作权限
 * - reader（阅读助手）：shared + reader 工具，聚焦内容理解
 * - paper（论文助手）：shared + 论文工具，基础层直接读 paper.md，增强层按向量能力门控
 * - mcp：外部 MCP Server 工具需异步连接，在 custom-chat-transport.ts 调 getMcpToolsForScope() 后
 *   与本函数返回值合并（见 src/ai/mcp/mcp-manager.ts），不在此同步组装
 */
import { useLlamaStore } from "@/store/llama-store";
import type { CoreTool } from "ai";
import {
  askAppHelpTool,
  convertPdfTool,
  downloadFileTool,
  editFileTool,
  exportNotesTool,
  extractZipTool,
  httpRequestTool,
  importBookTool,
  importFontTool,
  importPaperTool,
  manageBookTool,
  manageMcpTool,
  managePaperFoldersTool,
  managePreferencesTool,
  manageSecretsTool,
  manageSkillTool,
  manageSyncTool,
  manageTagsTool,
  manageThreadsTool,
  processPaperTool,
  readLocalFileTool,
  runCommandTool,
  searchFilesTool,
  switchModelTool,
  trashManagerTool,
  vectorizeBookTool,
  writeFileTool,
} from "./central";
import {
  createGetCitationsTool,
  createGetFiguresTool,
  createPaperContextTool,
  createPaperFullTool,
  createPaperInfoTool,
  createPaperSearchTool,
  createPaperSectionTool,
  createPaperTocTool,
  createRagContextTool,
  createRagRangeTool,
  createRagSearchTool,
  createRagTocTool,
  createReadBookSectionTool,
  getBooksTool,
  getReadingStatsTool,
  getSkillsTool,
  mindmapTool,
  notesTool,
  webSearchTool,
} from "./index";
import { createManageNotesTool } from "./manage-notes";

// ==================== 类型定义 ====================

export type ToolScope = "central" | "reader" | "shared" | "mcp";

export interface ToolRegistration {
  name: string;
  scope: ToolScope;
  tool: CoreTool;
  description: string;
}

export type AgentScope = "central" | "reader" | "paper";

export interface ToolContext {
  bookId?: string;
  /** 论文助手：当前论文 id（books 表中 format='MARKDOWN' 的行） */
  paperId?: string;
  /** 论文助手：paperSearch 的检索范围（null = 全部文献；数组 = 限定论文集合） */
  paperScopeIds?: string[] | null;
}

// ==================== 注册表 ====================

const registry: ToolRegistration[] = [];

export function registerTool(reg: ToolRegistration): void {
  const existing = registry.findIndex((r) => r.name === reg.name);
  if (existing >= 0) {
    registry[existing] = reg;
  } else {
    registry.push(reg);
  }
}

export function registerTools(regs: ToolRegistration[]): void {
  for (const reg of regs) {
    registerTool(reg);
  }
}

// ==================== 共享工具（两种 Agent 均可用） ====================

registerTools([
  {
    name: "notes",
    scope: "shared",
    tool: notesTool as CoreTool,
    description: "查询用户标注（划线与想法）",
  },
  {
    name: "getBooks",
    scope: "shared",
    tool: getBooksTool as CoreTool,
    description: "查询书籍列表和基本信息",
  },
  {
    name: "getReadingStats",
    scope: "shared",
    tool: getReadingStatsTool as CoreTool,
    description: "获取阅读统计数据",
  },
  {
    name: "getSkills",
    scope: "shared",
    tool: getSkillsTool as CoreTool,
    description: "获取可用技能列表",
  },
  {
    name: "mindmap",
    scope: "shared",
    tool: mindmapTool as CoreTool,
    description: "生成思维导图",
  },
  {
    name: "webSearch",
    scope: "shared",
    tool: webSearchTool as CoreTool,
    description: "网络搜索",
  },
  // P1 · 工作区文件/执行工具（2026-08-05 拍板下放：reader/paper 读着读着整理笔记落盘是直觉场景；
  // 安全分档由 transport 的 tool-guard 统一包装，三 scope 一致生效；网络外发类仍锁 central）
  {
    name: "readLocalFile",
    scope: "shared",
    tool: readLocalFileTool as CoreTool,
    description: "读取本地文件（行号分页）/列出目录",
  },
  {
    name: "writeFile",
    scope: "shared",
    tool: writeFileTool as CoreTool,
    description: "写入本地文件（工作区内静默，界外确认）",
  },
  {
    name: "editFile",
    scope: "shared",
    tool: editFileTool as CoreTool,
    description: "精确编辑本地文件局部内容（oldString 唯一性校验）",
  },
  {
    name: "searchFiles",
    scope: "shared",
    tool: searchFilesTool as CoreTool,
    description: "工作区内搜索文件（glob 按名 / grep 按内容）",
  },
  {
    name: "runCommand",
    scope: "shared",
    tool: runCommandTool as CoreTool,
    description: "在工作区执行命令行（超时/截断/审计日志）",
  },
  {
    name: "exportNotes",
    scope: "shared",
    tool: exportNotesTool as CoreTool,
    description: "导出书籍划线与笔记为 Markdown",
  },
  {
    name: "askAppHelp",
    scope: "shared",
    tool: askAppHelpTool as CoreTool,
    description: "SageRead 使用帮助问答（检索内置使用手册）",
  },
]);

// ==================== 全局助手专属工具 ====================

registerTools([
  {
    name: "manageBook",
    scope: "central",
    tool: manageBookTool as CoreTool,
    description: "书籍管理（删除入回收站/打开/重置进度）",
  },
  {
    name: "convertPdf",
    scope: "central",
    tool: convertPdfTool as CoreTool,
    description: "PDF 转 EPUB 并入库",
  },
  {
    name: "importBook",
    scope: "central",
    tool: importBookTool as CoreTool,
    description: "从本地路径导入书籍",
  },
  {
    name: "importPaper",
    scope: "central",
    tool: importPaperTool as CoreTool,
    description: "解析单篇 PDF 论文并导入文献库（paper.md 链路，非书库）",
  },
  {
    name: "manageSync",
    scope: "central",
    tool: manageSyncTool as CoreTool,
    description: "备份与同步（立即备份/备份列表/恢复/立即同步/同步偏好）",
  },
  {
    name: "vectorizeBook",
    scope: "central",
    tool: vectorizeBookTool as CoreTool,
    description: "向量化索引（支持批量）",
  },
  {
    name: "manageTags",
    scope: "central",
    tool: manageTagsTool as CoreTool,
    description: "创建/分配/移除标签",
  },
  {
    name: "trashManager",
    scope: "central",
    tool: trashManagerTool as CoreTool,
    description: "恢复或彻底删除回收站书籍",
  },
  {
    name: "managePreferences",
    scope: "central",
    tool: managePreferencesTool as CoreTool,
    description: "偏好设置（主题/明暗模式、阅读偏好、界面偏好）",
  },
  {
    name: "switchModel",
    scope: "central",
    tool: switchModelTool as CoreTool,
    description: "查看与切换聊天/辅助模型",
  },
  {
    name: "manageThreads",
    scope: "central",
    tool: manageThreadsTool as CoreTool,
    description: "对话管理（列表/搜索/标星/改名/删除/导出）",
  },
  {
    name: "importFont",
    scope: "central",
    tool: importFontTool as CoreTool,
    description: "从本地路径导入阅读字体",
  },
  {
    name: "httpRequest",
    scope: "central",
    tool: httpRequestTool as CoreTool,
    description: "通用 HTTP 请求（对接任意第三方 API）",
  },
  {
    name: "downloadFile",
    scope: "central",
    tool: downloadFileTool as CoreTool,
    description: "从 URL 下载文件到本地",
  },
  {
    name: "extractZip",
    scope: "central",
    tool: extractZipTool as CoreTool,
    description: "解压 ZIP 文件到目录",
  },
  {
    name: "manageSkill",
    scope: "central",
    tool: manageSkillTool as CoreTool,
    description: "创建/更新/启用停用/删除 AI 技能",
  },
  {
    name: "manageSecrets",
    scope: "central",
    tool: manageSecretsTool as CoreTool,
    description: "密钥保管箱管理（列名/保存/删除，无读出真值能力）",
  },
  {
    name: "manageMcp",
    scope: "central",
    tool: manageMcpTool as CoreTool,
    description: "管理 MCP 服务器配置（新增/修改/启停/删除）",
  },
  {
    name: "managePaperFolders",
    scope: "central",
    tool: managePaperFoldersTool as CoreTool,
    description: "文献库文件夹管理（查看/创建/重命名/删除/移动/归档论文）",
  },
  {
    name: "processPaper",
    scope: "central",
    tool: processPaperTool as CoreTool,
    description: "文献库论文翻译与句词对齐（status/translate/align；translate 自动带对齐）",
  },
  {
    name: "manageNotes",
    scope: "central",
    tool: createManageNotesTool() as CoreTool,
    description: "笔记面板管理（列出/读取/新建/修改/星标/导出；长文笔记，非划线标注）",
  },
]);

// ==================== 工具组装 ====================

/**
 * 根据 Agent 角色和上下文动态组装工具集
 */
export function getToolsForScope(agentScope: AgentScope, context?: ToolContext): Record<string, CoreTool> {
  const tools: Record<string, CoreTool> = {};

  // 1. 注入共享工具
  for (const reg of registry) {
    if (reg.scope === "shared") {
      tools[reg.name] = reg.tool;
    }
  }

  // 2. 注入角色专属工具
  for (const reg of registry) {
    if (reg.scope === agentScope) {
      tools[reg.name] = reg.tool;
    }
  }

  // 3. 阅读助手专属：RAG 工具（需要 bookId + 向量能力）+ 章节直读兜底（常驻；
  // 全局有向量能力 ≠ 本书已建索引——未建索引时 ragSearch 无结果，直读是唯一的正文通道）
  if (agentScope === "reader" && context?.bookId) {
    const hasVectorCapability = useLlamaStore.getState().hasVectorCapability();
    if (hasVectorCapability) {
      tools.ragSearch = createRagSearchTool(context.bookId) as CoreTool;
      tools.ragToc = createRagTocTool(context.bookId) as CoreTool;
      tools.ragContext = createRagContextTool(context.bookId) as CoreTool;
      tools.ragRange = createRagRangeTool(context.bookId) as CoreTool;
    }
    tools.readBookSection = createReadBookSectionTool(context.bookId) as CoreTool;
    // 笔记面板（绑定当前书；create/update 由 tool-guard 弹确认卡）
    tools.manageNotes = createManageNotesTool(context.bookId) as CoreTool;
  }

  // 4. 论文助手专属：基础层结构工具（始终可用，直接读 paper.md）+ 增强层语义检索（向量能力门控）
  if (agentScope === "paper" && context?.paperId) {
    tools.getPaperToc = createPaperTocTool(context.paperId) as CoreTool;
    tools.readPaperSection = createPaperSectionTool(context.paperId) as CoreTool;
    tools.readPaperFull = createPaperFullTool(context.paperId) as CoreTool;
    tools.getPaperInfo = createPaperInfoTool(context.paperId) as CoreTool;
    tools.getCitations = createGetCitationsTool(context.paperId) as CoreTool;
    tools.getFigures = createGetFiguresTool(context.paperId) as CoreTool;
    // 笔记面板（绑定当前论文；create/update 由 tool-guard 弹确认卡）
    tools.manageNotes = createManageNotesTool(context.paperId) as CoreTool;

    const hasVectorCapability = useLlamaStore.getState().hasVectorCapability();
    if (hasVectorCapability) {
      tools.paperSearch = createPaperSearchTool(context.paperScopeIds ?? null) as CoreTool;
      tools.paperContext = createPaperContextTool() as CoreTool;
    }
  }

  // 5. MCP 工具注入点（批次 B3）：远程 MCP 工具需异步连接且生命周期跟随单次聊天请求
  // （流结束要 closeAll），故不在此同步函数合并，而在 custom-chat-transport.ts 里
  // 调 getMcpToolsForScope() 后与本函数返回值合并，见 src/ai/mcp/mcp-manager.ts。

  return tools;
}

/**
 * 获取指定角色下所有工具的注册信息（用于系统提示词生成）
 */
export function getToolDescriptions(agentScope: AgentScope): string[] {
  const descriptions: string[] = [];

  for (const reg of registry) {
    if (reg.scope === "shared" || reg.scope === agentScope) {
      descriptions.push(`- ${reg.name}: ${reg.description}`);
    }
  }

  // 论文助手工具为上下文工厂创建（不在静态注册表），描述在此手动同步
  if (agentScope === "paper") {
    descriptions.push(
      "- getPaperToc: 获取当前论文的目录结构",
      "- readPaperSection: 按标题读取当前论文小节正文",
      "- readPaperFull: 通读当前论文全文",
      "- getPaperInfo: 获取当前论文元数据",
      "- getCitations: 提取当前论文的参考文献列表",
      "- getFigures: 提取当前论文的图片清单（图注与所在小节）",
      "- manageNotes: 笔记面板管理（列出/读取/新建/修改/星标/导出当前论文的笔记）",
    );
    if (useLlamaStore.getState().hasVectorCapability()) {
      descriptions.push("- paperSearch: 文献库语义检索（范围由用户选择）");
      descriptions.push("- paperContext: 扩展 paperSearch 命中片段的前后上下文");
    }
  }

  return descriptions;
}
