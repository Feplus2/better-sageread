/**
 * 全局助手工具：切换主题/明暗模式
 */
import { listGlobalThemes } from "@/services/global-theme-service";
import { useThemeStore } from "@/store/theme-store";
import { tool } from "ai";
import { z } from "zod";

/** 按文件名或显示名（@name）模糊解析主题；命中用户主题优先 */
async function resolveThemeName(input: string): Promise<{ name: string; label?: string } | null> {
  const themes = await listGlobalThemes();
  const q = input.trim().toLowerCase();
  if (!q) return null;

  // 精确匹配（文件名 / 显示名）
  const exact = themes.find((t) => t.name.toLowerCase() === q || t.label?.toLowerCase() === q);
  if (exact) return exact;

  // 包含匹配（如"蛋糕"命中"蛋糕（cake）"、 "parch" 命中 "parchment"）
  const fuzzy = themes.filter((t) => t.name.toLowerCase().includes(q) || t.label?.toLowerCase().includes(q));
  // 用户主题优先
  return fuzzy.find((t) => t.source === "user") ?? fuzzy[0] ?? null;
}

export const setThemeTool = tool({
  description: `切换应用的明暗模式或更换全局主题。

🎯 **核心功能**：
• 切换明暗模式：light（浅色）、dark（深色）、auto（跟随系统）
• 更换全局主题：globalTheme 传主题的文件名或显示名均可（如 "cake" 或 "蛋糕"），支持模糊匹配；传 "default" 恢复默认主题

📋 **前提条件**：系统提示词的「可用全局主题」一节列出了当前全部主题；用户说的主题不在清单里时，先告知可选清单再让用户选择

📊 **返回内容**：
操作结果确认`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    mode: z.enum(["light", "dark", "auto"]).optional().describe("明暗模式：light=浅色, dark=深色, auto=跟随系统"),
    globalTheme: z
      .string()
      .optional()
      .describe("全局主题名称（文件名或显示名，可模糊匹配），传 'default' 恢复默认主题"),
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
        if (globalTheme === "default") {
          await store.setGlobalTheme(null);
          results.push("已恢复默认主题");
        } else {
          const resolved = await resolveThemeName(globalTheme);
          if (!resolved) {
            const available = await listGlobalThemes();
            return {
              results: {
                success: false,
                message: `没有找到主题「${globalTheme}」。可用主题：${
                  available.map((t) => `${t.label ?? t.name}${t.source === "user" ? "（自定义）" : ""}`).join("、") ||
                  "无"
                }`,
              },
              meta: { reasoning },
            };
          }
          await store.setGlobalTheme(resolved.name);
          results.push(`已应用全局主题「${resolved.label ?? resolved.name}」`);
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
      throw new Error(`切换主题失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
