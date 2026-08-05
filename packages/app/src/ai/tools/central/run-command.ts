/**
 * 全局助手工具：执行命令行（Agent 工作区，P1）
 * 万能出口：python/ffmpeg/pandoc/imagemagick 等都经此运行。
 * cwd 钉死工作区根；任何模式都写审计日志（Rust 侧 {appData}/agent-audit/commands.jsonl）。
 */
import { useAgentSettingsStore } from "@/store/agent-settings-store";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";

interface RunCommandResponse {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export const runCommandTool = tool({
  description: `在工作区根目录下执行命令行（Windows cmd / unix sh），Agent 的万能执行出口。

🎯 **核心功能**：
• 跑脚本与命令行工具：python 数据处理/画图、ffmpeg 抽帧、imagemagick 压图、pandoc 转格式等
• 工作目录固定为工作区根，相对路径以此为基准
• 默认 120 秒超时（可调，上限 600 秒），超时自动杀进程
• stdout/stderr 各截断至 2 万字符回传

📊 **返回内容**：
退出码、stdout、stderr、是否超时、输出是否被截断

⚠️ **注意**：
• 每次执行都会记录审计日志；非"完全访问"模式下需用户确认后才执行
• 长输出重定向到文件再 readLocalFile 分段读，比直接回传更稳
• 交互式命令（等待输入）不要用，会卡到超时`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    command: z.string().min(1).describe("要执行的完整命令行"),
    timeoutSecs: z.number().int().min(1).max(600).optional().describe("超时秒数（默认 120，上限 600）"),
  }),

  execute: async ({
    reasoning,
    command,
    timeoutSecs,
    rootOverride,
  }: { reasoning: string; command: string; timeoutSecs?: number; rootOverride?: string | null }) => {
    try {
      const root = rootOverride !== undefined ? rootOverride : useAgentSettingsStore.getState().workspaceRoot;
      const res = await invoke<RunCommandResponse>("agent_run_command", {
        root,
        command,
        timeoutSecs: timeoutSecs ?? null,
      });
      return {
        results: {
          success: res.exitCode === 0 && !res.timedOut,
          message: res.timedOut
            ? `命令超时被终止（>${timeoutSecs ?? 120}s）`
            : `命令执行完毕，退出码 ${res.exitCode ?? "未知"}`,
          exitCode: res.exitCode,
          stdout: res.stdout,
          stderr: res.stderr,
          timedOut: res.timedOut,
          truncated: res.truncated,
        },
        meta: { reasoning, command },
      };
    } catch (error) {
      return {
        results: {
          success: false,
          message: `执行失败：${error instanceof Error ? error.message : String(error)}`,
        },
        meta: { reasoning, command },
      };
    }
  },
});
