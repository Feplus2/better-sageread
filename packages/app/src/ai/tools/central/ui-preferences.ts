/**
 * 全局助手工具：界面偏好设置（竖排标签栏/聊天自动滚动/阅读侧栏互换）
 */
import { useLayoutStore } from "@/store/layout-store";
import { useThemeStore } from "@/store/theme-store";
import { tool } from "ai";
import { z } from "zod";

export const uiPreferencesTool = tool({
  description: `调整界面偏好：阅读页标签栏方向、聊天自动滚动、阅读页侧栏位置互换。

🎯 **核心功能**：
• tabOrientation：标签栏方向（vertical=左侧竖排, horizontal=顶部横排）
• autoScroll：聊天时自动滚动到最新消息（true/false）
• swapSidebars：阅读页的聊天栏与笔记栏位置对调（true/false）

📊 **返回内容**：
生效后的当前偏好状态`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    tabOrientation: z
      .enum(["vertical", "horizontal"])
      .optional()
      .describe("标签栏方向：vertical=竖排, horizontal=横排"),
    autoScroll: z.boolean().optional().describe("聊天自动滚动到最新消息"),
    swapSidebars: z.boolean().optional().describe("阅读页聊天栏与笔记栏位置对调"),
  }),

  execute: async ({
    reasoning,
    tabOrientation,
    autoScroll,
    swapSidebars,
  }: {
    reasoning: string;
    tabOrientation?: "vertical" | "horizontal";
    autoScroll?: boolean;
    swapSidebars?: boolean;
  }) => {
    try {
      const changes: string[] = [];
      const themeStore = useThemeStore.getState();
      const layoutStore = useLayoutStore.getState();

      if (tabOrientation !== undefined && layoutStore.tabOrientation !== tabOrientation) {
        layoutStore.toggleTabOrientation();
        changes.push(`标签栏 → ${tabOrientation === "vertical" ? "竖排" : "横排"}`);
      }
      if (autoScroll !== undefined && themeStore.autoScroll !== autoScroll) {
        themeStore.setAutoScroll(autoScroll);
        changes.push(`聊天自动滚动 → ${autoScroll ? "开" : "关"}`);
      }
      if (swapSidebars !== undefined && themeStore.swapSidebars !== swapSidebars) {
        themeStore.setSwapSidebars(swapSidebars);
        changes.push(`阅读页侧栏互换 → ${swapSidebars ? "开" : "关"}`);
      }

      if (changes.length === 0) {
        return {
          results: { success: false, message: "未指定任何调整项，或目标状态与当前一致" },
          meta: { reasoning },
        };
      }

      const theme = useThemeStore.getState();
      return {
        results: {
          success: true,
          message: `已调整：${changes.join("；")}`,
          current: {
            标签栏: useLayoutStore.getState().tabOrientation === "vertical" ? "竖排" : "横排",
            聊天自动滚动: theme.autoScroll ? "开" : "关",
            侧栏互换: theme.swapSidebars ? "开" : "关",
          },
        },
        meta: { reasoning },
      };
    } catch (error) {
      throw new Error(`调整界面偏好失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
