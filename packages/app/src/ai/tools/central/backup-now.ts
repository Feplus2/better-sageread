/**
 * 全局助手工具：立即备份到云端
 */
import { syncBackupNow } from "@/services/sync-service";
import { tool } from "ai";
import { z } from "zod";

export const backupNowTool = tool({
  description: `立即执行一次云端备份（WebDAV）。

🎯 **核心功能**：
• 将本地数据库和配置备份到已配置的 WebDAV 云端
• 备份完成后返回备份文件名

⚠️ **前提条件**：需要已在 设置 → 同步 中配置 WebDAV

📊 **返回内容**：
备份结果（uploaded=已上传 / skipped=无变化跳过）`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
  }),

  execute: async ({ reasoning }: { reasoning: string }) => {
    try {
      const outcome = await syncBackupNow();

      const message =
        outcome.status === "uploaded" ? `备份成功，备份文件：${outcome.backup_name}` : `备份跳过（${outcome.message}）`;

      return {
        results: {
          success: true,
          status: outcome.status,
          message,
          backupName: outcome.backup_name,
        },
        meta: { reasoning },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "未知错误";
      if (errorMessage.includes("not configured") || errorMessage.includes("未配置")) {
        throw new Error("尚未配置 WebDAV 同步，请先在 设置 → 同步 中配置");
      }
      throw new Error(`备份失败: ${errorMessage}`);
    }
  },
});
