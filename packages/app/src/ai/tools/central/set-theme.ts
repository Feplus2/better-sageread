/**
 * 中央 Agent 工具：切换主题/明暗模式
 */
import { useThemeStore } from "@/store/theme-store";
import { tool } from "ai";
import { z } from "zod";

export const setThemeTool = tool({
  description: `切换应用的明暗模式或更换全局主题。

🎯 **核心功能**：
• 切换明暗模式：light（浅色）、dark（深色）、auto（跟随系统）
• 更换全局主题：使用已安装的主题包

📊 **返回内容**：
操作结果确认`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    mode: z.enum(["light", "dark", "auto"]).optional().describe("明暗模式：light=浅色, dark=深色, auto=跟随系统"),
    globalTheme: z.string().optional().describe("全局主题名称，传 null 或 'default' 恢复默认主题"),
  }),

  execute: async ({
    reasoning,
    mode,
    globalTheme,
  }: {
    reasoning: string;
    mode?: "light" | "dark" | "auto";
    globalTheme?: string;
  }) => {
    try {
      const store = useThemeStore.getState();
      const results: string[] = [];

      // 切换明暗模式
      if (mode) {
        store.setThemeMode(mode);
        const modeLabels: Record<string, string> = {
          light: "浅色模式",
          dark: "深色模式",
          auto: "跟随系统",
        };
        results.push(`已切换到${modeLabels[mode]}`);
      }

      // 更换全局主题
      if (globalTheme !== undefined) {
        const themeName = globalTheme === "default" ? null : globalTheme;
        await store.setGlobalTheme(themeName);
        if (themeName) {
          results.push(`已应用全局主题「${themeName}」`);
        } else {
          results.push("已恢复默认主题");
        }
      }

      if (results.length === 0) {
        return {
          results: {
            success: false,
            message: "未指定任何操作，请提供 mode 或 globalTheme 参数",
          },
          meta: { reasoning },
        };
      }

      return {
        results: {
          success: true,
          message: results.join("；"),
          currentMode: useThemeStore.getState().themeMode,
          currentGlobalTheme: useThemeStore.getState().globalTheme,
        },
        meta: { reasoning },
      };
    } catch (error) {
      throw new Error(`切换主题失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  },
});
