/**
 * 中央 Agent 工具：立即同步（L2 增量同步）
 */
import { syncPullNow, syncRunNow } from "@/services/sync-service";
import { tool } from "ai";
import { z } from "zod";

export const syncNowTool = tool({
  description: `立即执行一轮多设备增量同步。

🎯 **核心功能**：
• 双向同步（默认）：推送本地变更 + 拉取远端变更
• 仅拉取：只从远端拉取最新数据

⚠️ **前提条件**：需要已在 设置 → 同步 中开启 L2 增量同步

📊 **返回内容**：
同步结果（推送/拉取的行数、变更的书籍和对话）`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    direction: z.enum(["both", "pull"]).default("both").describe("同步方向：both=双向同步（默认）, pull=仅拉取远端"),
  }),

  execute: async ({ reasoning, direction }: { reasoning: string; direction: "both" | "pull" }) => {
    try {
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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "未知错误";
      if (
        errorMessage.includes("not configured") ||
        errorMessage.includes("未配置") ||
        errorMessage.includes("disabled")
      ) {
        throw new Error("尚未开启 L2 增量同步，请先在 设置 → 同步 中配置并开启");
      }
      throw new Error(`同步失败: ${errorMessage}`);
    }
  },
});
