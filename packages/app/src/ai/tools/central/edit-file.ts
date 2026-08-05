/**
 * 全局助手工具：精确编辑本地文件（Agent 工作区，P1）
 * 语义对齐 Kimi Code 的 Edit：oldString 精确匹配 + 唯一性校验，失败给可操作提示。
 * 界外写入的 allowOutside 由 transport 的 tool-guard 在确认卡通过后注入，不在 inputSchema 暴露。
 */
import { useAgentSettingsStore } from "@/store/agent-settings-store";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";

interface EditFileResponse {
  resolved: string;
  replacements: number;
}

export const editFileTool = tool({
  description: `精确编辑本地文件的局部内容（Agent 工作区），不整文件重写。

🎯 **核心功能**：
• 用 oldString 精确匹配（含缩进换行）定位，替换为 newString
• 默认要求唯一命中；多处命中需设 replaceAll=true 全部替换
• 适合：改报告段落、修脚本 bug、更新配置项

📊 **返回内容**：
文件路径与替换次数。匹配失败会返回可操作的修正提示

⚠️ **什么时候别用**：
• 创建新文件或整文件重写时用 writeFile
• 不确定文件当前内容时先 readLocalFile 核对再改，别猜`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    path: z.string().min(1).describe("目标文件路径（相对工作区根，或绝对路径）"),
    oldString: z.string().min(1).describe("要被替换的原文（精确匹配，含缩进与换行）"),
    newString: z.string().describe("替换后的新内容"),
    replaceAll: z.boolean().default(false).describe("true=替换所有命中；false=要求唯一命中"),
  }),

  execute: async ({
    reasoning,
    path,
    oldString,
    newString,
    replaceAll,
    allowOutside,
    rootOverride,
  }: {
    reasoning: string;
    path: string;
    oldString: string;
    newString: string;
    replaceAll: boolean;
    allowOutside?: boolean;
    rootOverride?: string | null;
  }) => {
    try {
      const root = rootOverride !== undefined ? rootOverride : useAgentSettingsStore.getState().workspaceRoot;
      const res = await invoke<EditFileResponse>("agent_edit_file", {
        root,
        path,
        oldString,
        newString,
        replaceAll: replaceAll === true,
        allowOutside: allowOutside === true,
      });
      return {
        results: {
          success: true,
          message: `已修改 ${res.resolved}（替换 ${res.replacements} 处）`,
          path: res.resolved,
          replacements: res.replacements,
        },
        meta: { reasoning, path: res.resolved },
      };
    } catch (error) {
      return {
        results: {
          success: false,
          message: `编辑失败：${error instanceof Error ? error.message : String(error)}`,
        },
        meta: { reasoning, path },
      };
    }
  },
});
