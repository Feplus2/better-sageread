/**
 * 全局助手工具：读取本地文件/目录
 * P1 加固：read 模式改走 Rust agent_read_file（行号 + offset/limit 分页 + 8MB 上限），
 * list 模式沿用 plugin-fs；界外读取的确认分档由 transport 的 tool-guard 包装。
 */
import { useAgentSettingsStore } from "@/store/agent-settings-store";
import { invoke } from "@tauri-apps/api/core";
import { exists, readDir } from "@tauri-apps/plugin-fs";
import { tool } from "ai";
import { z } from "zod";

interface AgentReadResponse {
  resolved: string;
  totalLines: number;
  truncated: boolean;
  content: string;
}

export const readLocalFileTool = tool({
  description: `读取本地文件内容或列出目录结构。

🎯 **核心功能**：
• mode=read：读取文本文件（.md / .json / .txt / .py 等），带行号返回；大文件用 offset/limit 分页读
• mode=list：列出目录下的文件和子目录

📊 **返回内容**：
read：带行号的内容（格式 "行号<TAB>内容"）、总行数、是否还有剩余；list：目录项列表

⚠️ **什么时候别用**：
• 不知道文件在哪时先 searchFiles 找，别逐个目录翻
• 读取书籍正文/论文内容用各自的领域工具（readPaperSection 等），这里只读工作区与本地文件`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    path: z.string().min(1).describe("文件或目录的完整本地路径（相对工作区根，或绝对路径）"),
    mode: z.enum(["read", "list"]).default("read").describe("read=读取文件内容, list=列出目录"),
    offset: z.number().int().min(1).optional().describe("起始行号（1 起，默认 1；仅 read 模式）"),
    limit: z.number().int().min(1).max(2000).optional().describe("读取行数（默认 2000，上限 2000；仅 read 模式）"),
  }),

  execute: async ({
    reasoning,
    path,
    mode,
    offset,
    limit,
    rootOverride,
  }: {
    reasoning: string;
    path: string;
    mode: "read" | "list";
    offset?: number;
    limit?: number;
    rootOverride?: string | null;
  }) => {
    try {
      if (mode === "list") {
        const pathExists = await exists(path);
        if (!pathExists) {
          return {
            results: { success: false, message: `路径不存在：${path}` },
            meta: { reasoning, path },
          };
        }
        const entries = await readDir(path);
        const items = entries.map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory,
        }));
        return {
          results: {
            success: true,
            message: `目录 ${path} 下有 ${items.length} 项`,
            items,
          },
          meta: { reasoning, path },
        };
      }

      // read 模式：Rust 侧分页 + 行号
      const root = rootOverride !== undefined ? rootOverride : useAgentSettingsStore.getState().workspaceRoot;
      const res = await invoke<AgentReadResponse>("agent_read_file", {
        root,
        path,
        offset: offset ?? null,
        limit: limit ?? null,
      });
      return {
        results: {
          success: true,
          message: `已读取 ${res.resolved}（共 ${res.totalLines} 行${res.truncated ? "，未读完，可用 offset 续读" : ""}）`,
          content: res.content,
          totalLines: res.totalLines,
          truncated: res.truncated,
        },
        meta: { reasoning, path: res.resolved },
      };
    } catch (error) {
      return {
        results: { success: false, message: `读取失败：${error instanceof Error ? error.message : String(error)}` },
        meta: { reasoning, path },
      };
    }
  },
});
