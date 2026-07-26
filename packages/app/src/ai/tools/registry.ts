/**
 * 工具注册框架：按 Agent 角色（central / reader）动态组装工具集。
 *
 * - central（中央 Agent）：shared + central 工具，拥有全局操作权限
 * - reader（阅读助手）：shared + reader 工具，聚焦内容理解
 * - mcp：预留，后续迭代接入外部 MCP Server
 */
import { useLlamaStore } from "@/store/llama-store";
import type { CoreTool } from "ai";
import {
  backupNowTool,
  convertPdfTool,
  deleteBookTool,
  exportThreadsTool,
  getThreadsTool,
  importBookTool,
  manageTagsTool,
  openBookTool,
  resetProgressTool,
  setThemeTool,
  syncNowTool,
  trashManagerTool,
  vectorizeBookTool,
} from "./central";
import {
  createRagContextTool,
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

export type AgentScope = "central" | "reader";

export interface ToolContext {
  bookId?: string;
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
    description: "查询用户笔记",
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

// ==================== 中央 Agent 专属工具 ====================

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
    }
  }

  // 4. 预留 MCP 工具注入点（后续迭代）
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

  return descriptions;
}
