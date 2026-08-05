/**
 * 全局助手工具：搜索文件（Agent 工作区，P1）
 * 单工具双 mode：glob 按文件名模式找文件 / grep 按内容正则搜。
 */
import { useAgentSettingsStore } from "@/store/agent-settings-store";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";

interface SearchFilesResponse {
  matches: string[];
  truncated: boolean;
  searchedFiles: number;
}

export const searchFilesTool = tool({
  description: `在 Agent 工作区内搜索文件，两种模式：

🎯 **模式选择**：
• mode=glob：按文件名模式找文件（如 "**/*.md"、"reports/*.xlsx"），按修改时间倒序，上限 200 条
• mode=grep：按内容正则搜索文本文件，返回 "路径:行号:内容"，上限 100 条（自动跳过二进制与 >2MB 文件）

📊 **返回内容**：
匹配列表、是否截断、实际搜索的文件数

⚠️ **什么时候别用**：
• 已知确切路径时直接 readLocalFile，别搜
• 搜索书籍/笔记等应用内数据用各自的领域工具，这里只搜工作区文件`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    mode: z.enum(["glob", "grep"]).describe("glob=按文件名模式找文件；grep=按内容正则搜"),
    pattern: z.string().min(1).describe("glob 模式（如 **/*.md）或内容正则"),
    subdir: z.string().optional().describe("限定搜索的子目录（相对工作区根；缺省为整个工作区）"),
  }),

  execute: async ({
    reasoning,
    mode,
    pattern,
    subdir,
    rootOverride,
  }: { reasoning: string; mode: "glob" | "grep"; pattern: string; subdir?: string; rootOverride?: string | null }) => {
    try {
      const root = rootOverride !== undefined ? rootOverride : useAgentSettingsStore.getState().workspaceRoot;
      const res = await invoke<SearchFilesResponse>("agent_search_files", {
        root,
        mode,
        pattern,
        subdir: subdir ?? null,
      });
      return {
        results: {
          success: true,
          message: res.matches.length
            ? `找到 ${res.matches.length} 条匹配${res.truncated ? "（已达上限被截断）" : ""}，搜索了 ${res.searchedFiles} 个文件`
            : `无匹配（搜索了 ${res.searchedFiles} 个文件）`,
          matches: res.matches,
          truncated: res.truncated,
        },
        meta: { reasoning, mode, pattern, subdir },
      };
    } catch (error) {
      return {
        results: {
          success: false,
          message: `搜索失败：${error instanceof Error ? error.message : String(error)}`,
        },
        meta: { reasoning, mode, pattern },
      };
    }
  },
});
