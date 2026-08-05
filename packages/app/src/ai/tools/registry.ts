/**
 * 工具注册框架：按 Agent 角色（central / reader / paper）动态组装工具集。
 *
 * - central（全局助手）：shared + central 工具，拥有全局操作权限
 * - reader（阅读助手）：shared + reader 工具，聚焦内容理解
 * - paper（论文助手）：shared + 论文工具，基础层直接读 paper.md，增强层按向量能力门控
 * - mcp：预留，后续迭代接入外部 MCP Server
 */
import { useLlamaStore } from "@/store/llama-store";
import type { CoreTool } from "ai";
import {
  askAppHelpTool,
  backupNowTool,
  backupRestoreTool,
  convertPdfTool,
  deleteBookTool,
  downloadFileTool,
  exportNotesTool,
  exportThreadsTool,
  extractZipTool,
  getThreadsTool,
  httpRequestTool,
  importBookTool,
  importFontTool,
  managePaperFoldersTool,
  manageSkillTool,
  manageTagsTool,
  manageThreadsTool,
  openBookTool,
  readLocalFileTool,
  readerPreferencesTool,
  resetProgressTool,
  setThemeTool,
  switchModelTool,
  syncNowTool,
  syncPreferencesTool,
  toggleSkillTool,
  trashManagerTool,
  uiPreferencesTool,
  vectorizeBookTool,
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
  getBooksTool,
  getReadingStatsTool,
  getSkillsTool,
  mindmapTool,
  notesTool,
  webSearchTool,
} from "./index";

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
]);

// ==================== 全局助手专属工具 ====================

registerTools([
  {
    name: "setTheme",
    scope: "central",
    tool: setThemeTool as CoreTool,
    description: "切换明暗模式或更换全局主题",
  },
  {
    name: "deleteBook",
    scope: "central",
    tool: deleteBookTool as CoreTool,
    description: "删除书籍（移入回收站）",
  },
  {
    name: "convertPdf",
    scope: "central",
    tool: convertPdfTool as CoreTool,
    description: "PDF 转 EPUB 并入库",
  },
  {
    name: "exportThreads",
    scope: "central",
    tool: exportThreadsTool as CoreTool,
    description: "导出对话记录为 Markdown",
  },
  {
    name: "resetProgress",
    scope: "central",
    tool: resetProgressTool as CoreTool,
    description: "重置阅读进度",
  },
  {
    name: "getThreads",
    scope: "central",
    tool: getThreadsTool as CoreTool,
    description: "查询/搜索对话记录",
  },
  {
    name: "importBook",
    scope: "central",
    tool: importBookTool as CoreTool,
    description: "从本地路径导入书籍",
  },
  {
    name: "openBook",
    scope: "central",
    tool: openBookTool as CoreTool,
    description: "在阅读器中打开书籍",
  },
  {
    name: "backupNow",
    scope: "central",
    tool: backupNowTool as CoreTool,
    description: "立即备份到云端",
  },
  {
    name: "syncNow",
    scope: "central",
    tool: syncNowTool as CoreTool,
    description: "立即执行多设备同步",
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
    name: "exportNotes",
    scope: "central",
    tool: exportNotesTool as CoreTool,
    description: "导出书籍划线与笔记为 Markdown",
  },
  {
    name: "readerPreferences",
    scope: "central",
    tool: readerPreferencesTool as CoreTool,
    description: "调整阅读偏好（字号/字体/行高/背景）",
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
    description: "对话管理（标星/改名/删除）",
  },
  {
    name: "syncPreferences",
    scope: "central",
    tool: syncPreferencesTool as CoreTool,
    description: "同步与备份偏好设置",
  },
  {
    name: "backupRestore",
    scope: "central",
    tool: backupRestoreTool as CoreTool,
    description: "查看/恢复云端备份",
  },
  {
    name: "uiPreferences",
    scope: "central",
    tool: uiPreferencesTool as CoreTool,
    description: "界面偏好（竖排标签/自动滚动/侧栏互换）",
  },
  {
    name: "toggleSkill",
    scope: "central",
    tool: toggleSkillTool as CoreTool,
    description: "启用/停用 AI 技能",
  },
  {
    name: "importFont",
    scope: "central",
    tool: importFontTool as CoreTool,
    description: "从本地路径导入阅读字体",
  },
  {
    name: "askAppHelp",
    scope: "central",
    tool: askAppHelpTool as CoreTool,
    description: "SageRead 使用帮助问答（检索内置使用手册）",
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
    name: "readLocalFile",
    scope: "central",
    tool: readLocalFileTool as CoreTool,
    description: "读取本地文件/目录",
  },
  {
    name: "manageSkill",
    scope: "central",
    tool: manageSkillTool as CoreTool,
    description: "创建/更新 AI 技能",
  },
  {
    name: "managePaperFolders",
    scope: "central",
    tool: managePaperFoldersTool as CoreTool,
    description: "文献库文件夹管理（查看/创建/重命名/删除/移动/归档论文）",
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

  // 3. 阅读助手专属：RAG 工具（需要 bookId + 向量能力）
  if (agentScope === "reader" && context?.bookId) {
    const hasVectorCapability = useLlamaStore.getState().hasVectorCapability();
    if (hasVectorCapability) {
      tools.ragSearch = createRagSearchTool(context.bookId) as CoreTool;
      tools.ragToc = createRagTocTool(context.bookId) as CoreTool;
      tools.ragContext = createRagContextTool(context.bookId) as CoreTool;
      tools.ragRange = createRagRangeTool(context.bookId) as CoreTool;
    }
  }

  // 4. 论文助手专属：基础层结构工具（始终可用，直接读 paper.md）+ 增强层语义检索（向量能力门控）
  if (agentScope === "paper" && context?.paperId) {
    tools.getPaperToc = createPaperTocTool(context.paperId) as CoreTool;
    tools.readPaperSection = createPaperSectionTool(context.paperId) as CoreTool;
    tools.readPaperFull = createPaperFullTool(context.paperId) as CoreTool;
    tools.getPaperInfo = createPaperInfoTool(context.paperId) as CoreTool;
    tools.getCitations = createGetCitationsTool(context.paperId) as CoreTool;
    tools.getFigures = createGetFiguresTool(context.paperId) as CoreTool;

    const hasVectorCapability = useLlamaStore.getState().hasVectorCapability();
    if (hasVectorCapability) {
      tools.paperSearch = createPaperSearchTool(context.paperScopeIds ?? null) as CoreTool;
      tools.paperContext = createPaperContextTool() as CoreTool;
    }
  }

  // 5. 预留 MCP 工具注入点（后续迭代）
  // for (const reg of registry) {
  //   if (reg.scope === "mcp") {
  //     tools[reg.name] = reg.tool;
  //   }
  // }

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
    );
    if (useLlamaStore.getState().hasVectorCapability()) {
      descriptions.push("- paperSearch: 文献库语义检索（范围由用户选择）");
      descriptions.push("- paperContext: 扩展 paperSearch 命中片段的前后上下文");
    }
  }

  return descriptions;
}
