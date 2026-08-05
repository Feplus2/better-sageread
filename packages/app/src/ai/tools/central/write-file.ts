/**
 * 全局助手工具：写入本地文件（Agent 工作区，P1）
 * 界外写入的 allowOutside 由 transport 的 tool-guard 在确认卡通过后注入，不在 inputSchema 暴露。
 */
import { useAgentSettingsStore } from "@/store/agent-settings-store";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";

interface WriteFileResponse {
  resolved: string;
  bytes: number;
  created: boolean;
}

export const writeFileTool = tool({
  description: `写入本地文件（整文件创建或覆盖），默认落点在 Agent 工作区内。

🎯 **核心功能**：
• 在工作区创建新文件（自动创建父目录）或整文件覆盖已有文件
• 适合：生成报告/笔记/脚本/数据文件、把整理结果落盘

📊 **返回内容**：
实际写入的绝对路径、字节数、是否新建

⚠️ **什么时候别用**：
• 只改文件的局部内容时别用——改用 editFile 精确替换，整文件重写容易毁掉不该动的部分
• 单纯读取用 readLocalFile，找文件用 searchFiles`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    path: z.string().min(1).describe("目标文件路径（相对工作区根，或绝对路径）"),
    content: z.string().describe("要写入的完整内容"),
  }),

  execute: async ({
    reasoning,
    path,
    content,
    allowOutside,
    rootOverride,
  }: { reasoning: string; path: string; content: string; allowOutside?: boolean; rootOverride?: string | null }) => {
    try {
      const root = rootOverride !== undefined ? rootOverride : useAgentSettingsStore.getState().workspaceRoot;
      const res = await invoke<WriteFileResponse>("agent_write_file", {
        root,
        path,
        content,
        allowOutside: allowOutside === true,
      });
      return {
        results: {
          success: true,
          message: res.created
            ? `已创建 ${res.resolved}（${res.bytes} 字节）`
            : `已覆盖 ${res.resolved}（${res.bytes} 字节）`,
          path: res.resolved,
          bytes: res.bytes,
        },
        meta: { reasoning, path: res.resolved },
      };
    } catch (error) {
      return {
        results: {
          success: false,
          message: `写入失败：${error instanceof Error ? error.message : String(error)}`,
        },
        meta: { reasoning, path },
      };
    }
  },
});
