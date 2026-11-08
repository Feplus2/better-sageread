import { useAgentSettingsStore } from "@/store/agent-settings-store";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";

interface WorkspaceStat {
  resolved: string;
  exists: boolean;
  isDirectory: boolean;
}

export const presentTool = tool({
  description: `明确交付一个真实存在且允许读取的文件给用户。
仅在文件是本轮要交付的成果时调用，不要把每个新建文件、测试脚本或中间产物都列为交付物。
文件不必由本轮创建或编辑；可交付已有的 README 等最终文件。只检查元信息，不读取文件内容。
path 可以是相对工作区根的路径或绝对路径；description 用一句话说明交付内容。`,
  inputSchema: z.object({
    reasoning: z.string().min(1).describe("为什么这个文件值得作为成果交付"),
    path: z.string().min(1).describe("要交付的文件路径"),
    description: z.string().max(500).optional().describe("交付内容的一句话说明"),
  }),
  execute: async ({
    reasoning,
    path,
    description,
    rootOverride,
    allowOutside,
    expectedResolved,
  }: {
    reasoning: string;
    path: string;
    description?: string;
    rootOverride?: string | null;
    allowOutside?: boolean;
    expectedResolved?: string;
  }) => {
    try {
      const root = rootOverride !== undefined ? rootOverride : useAgentSettingsStore.getState().workspaceRoot;
      const stat = await invoke<WorkspaceStat>("agent_workspace_stat", {
        root,
        path,
        allowOutside: allowOutside ?? null,
        expectedResolved: expectedResolved ?? null,
      });
      if (!stat.exists || stat.isDirectory) {
        return { results: { success: false, message: "交付失败：文件不存在或是目录" }, meta: { reasoning, path } };
      }
      return {
        results: {
          success: true,
          deliverable: {
            path: stat.resolved,
            ...(description?.trim() ? { description: description.trim() } : {}),
          },
        },
        meta: { reasoning, path: stat.resolved },
      };
    } catch (error) {
      return {
        results: { success: false, message: `交付失败：${error instanceof Error ? error.message : String(error)}` },
        meta: { reasoning, path },
      };
    }
  },
});
