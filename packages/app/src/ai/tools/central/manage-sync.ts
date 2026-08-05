/**
 * 全局助手工具：备份与同步管理
 *
 * 合并自原 backupNow / backupRestore / syncNow / syncPreferences 四个工具，执行逻辑原样搬入
 *
 * 恢复语义：sync_restore 只是"暂存"，应用重启后才真正替换数据库；
 * 恢复前自动先做一次当前状态的备份（可回滚）
 *
 * 偏好更新走 Rust 端补丁合并（sync_update_prefs）：只传要改的非敏感字段，
 * WebDAV 地址/用户名/密码不经过此工具，也不会出现在返回值里
 */
import {
  syncBackupNow,
  syncListBackups,
  syncPullNow,
  syncRestartApp,
  syncRestore,
  syncRunNow,
  syncUpdatePrefs,
} from "@/services/sync-service";
import { tool } from "ai";
import { z } from "zod";

export const manageSyncTool = tool({
  description: `备份与同步管理：立即备份、查看/恢复云端备份、立即同步、调整同步偏好。

🎯 **核心功能**：
• action=backupNow：立即备份本地数据库和配置到 WebDAV 云端
• action=listBackups：列出云端全部备份（时间、设备、大小）
• action=restore：恢复到指定备份。恢复前会自动先备份当前状态（防丢）；恢复在重启应用后生效，restart=true 立即重启
• action=syncNow：立即执行一轮多设备增量同步（direction: both=双向同步, pull=仅拉取远端）
• action=updatePrefs：调整同步偏好——autoBackup（off/hourly/daily）、backupKeep（1-50）、syncFrequency（off/30s/5min/30min）、l2Enabled（增量同步开关）

⚠️ **危险操作**：restore 会整体替换当前书库数据，必须先向用户确认目标备份，并询问是否立即重启

⚠️ **前提条件**：需要已在 设置 → 同步 中配置 WebDAV；偏好频率类改动在下次启动或页面刷新后完全生效

📊 **返回内容**：
备份/同步结果、备份列表、恢复暂存结果，或生效后的完整偏好视图（不含任何密钥信息）`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    action: z
      .enum(["backupNow", "listBackups", "restore", "syncNow", "updatePrefs"])
      .describe(
        "backupNow=立即备份, listBackups=查看备份, restore=恢复备份, syncNow=立即同步, updatePrefs=调整同步偏好",
      ),
    backupName: z.string().optional().describe("目标备份文件名（action=restore 时必填，先 action=listBackups 获取）"),
    restart: z.boolean().default(false).describe("restore 时是否立即重启应用使恢复生效（默认 false=稍后手动重启）"),
    direction: z
      .enum(["both", "pull"])
      .default("both")
      .describe("syncNow 同步方向：both=双向同步（默认）, pull=仅拉取远端"),
    autoBackup: z.enum(["off", "hourly", "daily"]).optional().describe("updatePrefs：自动备份频率"),
    backupKeep: z.number().int().min(1).max(50).optional().describe("updatePrefs：云端备份保留份数（1-50）"),
    syncFrequency: z.enum(["off", "30s", "5min", "30min"]).optional().describe("updatePrefs：拉取兜底频率"),
    l2Enabled: z.boolean().optional().describe("updatePrefs：增量同步开关"),
  }),

  execute: async ({
    reasoning,
    action,
    backupName,
    restart,
    direction,
    autoBackup,
    backupKeep,
    syncFrequency,
    l2Enabled,
  }: {
    reasoning: string;
    action: "backupNow" | "listBackups" | "restore" | "syncNow" | "updatePrefs";
    backupName?: string;
    restart: boolean;
    direction: "both" | "pull";
    autoBackup?: "off" | "hourly" | "daily";
    backupKeep?: number;
    syncFrequency?: "off" | "30s" | "5min" | "30min";
    l2Enabled?: boolean;
  }) => {
    try {
      // ==================== 立即备份 ====================
      if (action === "backupNow") {
        const outcome = await syncBackupNow();

        const message =
          outcome.status === "uploaded"
            ? `备份成功，备份文件：${outcome.backup_name}`
            : `备份跳过（${outcome.message}）`;

        return {
          results: {
            success: true,
            status: outcome.status,
            message,
            backupName: outcome.backup_name,
          },
          meta: { reasoning },
        };
      }

      // ==================== 备份列表 ====================
      if (action === "listBackups") {
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

      // ==================== 恢复备份 ====================
      if (action === "restore") {
        if (!backupName?.trim()) {
          return {
            results: {
              success: false,
              message: "action=restore 需要提供 backupName（先 action=listBackups 查看可用备份）",
            },
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
      }

      // ==================== 立即同步 ====================
      if (action === "syncNow") {
        const result = direction === "pull" ? await syncPullNow() : await syncRunNow();

        const summary: string[] = [];
        if (result.pushed_rows > 0) summary.push(`推送 ${result.pushed_rows} 条变更`);
        if (result.pulled_rows > 0) summary.push(`拉取 ${result.pulled_rows} 条变更`);
        if (result.books_changed) summary.push("书架有更新");
        if (result.notes_changed) summary.push("笔记/划线有更新");
        if (result.thread_ids.length > 0) summary.push(`${result.thread_ids.length} 个对话有更新`);
        if (result.fonts_downloaded > 0) summary.push(`下载 ${result.fonts_downloaded} 个字体`);
        if (result.backgrounds_downloaded > 0) summary.push(`下载 ${result.backgrounds_downloaded} 张背景图`);

        return {
          results: {
            success: true,
            status: result.status,
            message: summary.length > 0 ? `同步完成：${summary.join("，")}` : `同步完成（${result.message}）`,
            pushedRows: result.pushed_rows,
            pulledRows: result.pulled_rows,
            booksChanged: result.books_changed,
            notesChanged: result.notes_changed,
          },
          meta: { reasoning, direction },
        };
      }

      // ==================== 更新同步偏好 ====================
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (
        errorMessage.includes("not configured") ||
        errorMessage.includes("未配置") ||
        errorMessage.includes("disabled") ||
        errorMessage.includes("尚未配置")
      ) {
        throw new Error("尚未配置或开启 WebDAV 同步，请先在 设置 → 同步 中完成配置");
      }
      throw new Error(`备份同步操作失败: ${errorMessage}`);
    }
  },
});
