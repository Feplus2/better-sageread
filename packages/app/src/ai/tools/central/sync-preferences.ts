/**
 * 全局助手工具：同步与备份偏好设置
 *
 * 走 Rust 端补丁合并（sync_update_prefs）：只传要改的非敏感字段，
 * WebDAV 地址/用户名/密码不经过此工具，也不会出现在返回值里
 */
import { syncUpdatePrefs } from "@/services/sync-service";
import { tool } from "ai";
import { z } from "zod";

export const syncPreferencesTool = tool({
  description: `调整同步与备份偏好：自动备份频率、备份保留份数、拉取频率、增量同步开关。

🎯 **核心功能**：
• autoBackup：自动备份频率（off=关闭, hourly=每小时, daily=每天）
• backupKeep：云端备份保留份数（1-50，默认 10）
• syncFrequency：拉取兜底频率（off=关闭, 30s, 5min, 30min；推送不受此项影响）
• l2Enabled：增量同步总开关

📋 **前提条件**：已配置 WebDAV；频率类改动在下次启动或页面刷新后完全生效

📊 **返回内容**：
生效后的完整偏好视图（不含任何密钥信息）`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    autoBackup: z.enum(["off", "hourly", "daily"]).optional().describe("自动备份频率"),
    backupKeep: z.number().int().min(1).max(50).optional().describe("云端备份保留份数（1-50）"),
    syncFrequency: z.enum(["off", "30s", "5min", "30min"]).optional().describe("拉取兜底频率"),
    l2Enabled: z.boolean().optional().describe("增量同步开关"),
  }),

  execute: async ({
    reasoning,
    autoBackup,
    backupKeep,
    syncFrequency,
    l2Enabled,
  }: {
    reasoning: string;
    autoBackup?: "off" | "hourly" | "daily";
    backupKeep?: number;
    syncFrequency?: "off" | "30s" | "5min" | "30min";
    l2Enabled?: boolean;
  }) => {
    try {
      if (
        autoBackup === undefined &&
        backupKeep === undefined &&
        syncFrequency === undefined &&
        l2Enabled === undefined
      ) {
        return {
          results: { success: false, message: "未指定任何要修改的偏好项" },
          meta: { reasoning },
        };
      }

      const view = await syncUpdatePrefs({ autoBackup, backupKeep, syncFrequency, l2Enabled });

      const autoBackupLabels: Record<string, string> = { off: "关闭", hourly: "每小时", daily: "每天" };
      return {
        results: {
          success: true,
          message: "同步偏好已更新",
          current: {
            自动备份: autoBackupLabels[view.auto_backup] ?? view.auto_backup,
            备份保留份数: view.backup_keep,
            拉取频率: view.sync_frequency,
            增量同步: view.l2_enabled ? "开启" : "关闭",
          },
        },
        meta: { reasoning },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("尚未配置")) {
        throw new Error("尚未配置 WebDAV，请先在 设置 → 同步 中完成配置");
      }
      throw new Error(`更新同步偏好失败: ${msg}`);
    }
  },
});
