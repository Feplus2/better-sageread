/**
 * 全局助手工具：云端备份的查看与恢复
 *
 * 恢复语义：sync_restore 只是"暂存"，应用重启后才真正替换数据库；
 * 恢复前自动先做一次当前状态的备份（可回滚）
 */
import { syncBackupNow, syncListBackups, syncRestartApp, syncRestore } from "@/services/sync-service";
import { tool } from "ai";
import { z } from "zod";

export const backupRestoreTool = tool({
  description: `查看云端备份列表，或把书库恢复到某个历史备份。

🎯 **核心功能**：
• action=list：列出云端全部备份（时间、设备、大小）
• action=restore：恢复到指定备份。恢复前会自动先备份当前状态（防丢）；恢复在重启应用后生效，restart=true 立即重启

⚠️ **危险操作**：恢复会整体替换当前书库数据，必须先向用户确认目标备份，并询问是否立即重启

📊 **返回内容**：
备份列表 / 恢复暂存结果`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    action: z.enum(["list", "restore"]).describe("list=查看备份, restore=恢复备份"),
    backupName: z.string().optional().describe("目标备份文件名（action=restore 时必填，先 action=list 获取）"),
    restart: z.boolean().default(false).describe("restore 时是否立即重启应用使恢复生效（默认 false=稍后手动重启）"),
  }),

  execute: async ({
    reasoning,
    action,
    backupName,
    restart,
  }: {
    reasoning: string;
    action: "list" | "restore";
    backupName?: string;
    restart: boolean;
  }) => {
    try {
      if (action === "list") {
        const backups = await syncListBackups();
        return {
          results: {
            success: true,
            total: backups.length,
            backups: backups.map((b) => ({
              name: b.name,
              createdAt: new Date(b.created_at).toISOString(),
              device: b.device,
              appVersion: b.app_version,
              sizeMB: Math.round((b.size / 1024 / 1024) * 10) / 10,
            })),
          },
          meta: { reasoning },
        };
      }

      // action=restore
      if (!backupName?.trim()) {
        return {
          results: { success: false, message: "action=restore 需要提供 backupName（先 action=list 查看可用备份）" },
          meta: { reasoning },
        };
      }

      // 恢复前先给当前状态留一份备份（尽力而为：失败仅提示，不阻断恢复）
      let safetyNote = "";
      try {
        const safety = await syncBackupNow();
        safetyNote =
          safety.status === "uploaded" ? `当前状态已先备份为 ${safety.backup_name}` : "当前状态无变化，无需额外备份";
      } catch {
        safetyNote = "当前状态预备份失败（网络异常？），请确认后谨慎继续";
      }

      await syncRestore(backupName.trim());

      if (restart) {
        setTimeout(() => {
          void syncRestartApp();
        }, 800);
        return {
          results: {
            success: true,
            message: `${safetyNote}；已暂存恢复到备份「${backupName}」，应用即将重启并生效`,
          },
          meta: { reasoning, backupName },
        };
      }

      return {
        results: {
          success: true,
          message: `${safetyNote}；已暂存恢复到备份「${backupName}」，重启应用后生效（可让我帮你重启）`,
        },
        meta: { reasoning, backupName },
      };
    } catch (error) {
      throw new Error(`备份操作失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
