/**
 * 全局助手工具：偏好设置（主题 / 阅读偏好 / 界面偏好）
 *
 * 合并自原 setTheme / readerPreferences / uiPreferences 三个工具，执行逻辑原样搬入
 *
 * 数据源：
 * - theme-store（明暗模式 / 全局主题 / 阅读背景 / 自动滚动 / 侧栏互换）
 * - app-settings-store.globalViewSettings（字号/字体/行高）
 * - layout-store（标签栏方向）
 * 改动立即写入全局默认，并实时套用到所有已打开的书籍渲染器
 */
import { CURATED_FONTS } from "@/services/constants";
import { listGlobalThemes } from "@/services/global-theme-service";
import { syncUiConfigNow } from "@/services/ui-config-sync";
import { useAppSettingsStore } from "@/store/app-settings-store";
import { useFontStore } from "@/store/font-store";
import { useLayoutStore } from "@/store/layout-store";
import { useThemeStore } from "@/store/theme-store";
import { readerScenes } from "@/styles/reader-scenes";
import { getStyles } from "@/utils/style";
import { tool } from "ai";
import { z } from "zod";

const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 32;

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

/** 把更新后的全局视图设置实时套用到所有打开的书籍渲染器 */
function applyToOpenReaders(updated: ReturnType<typeof getViewSettings>) {
  const { readerStores } = useLayoutStore.getState();
  for (const store of readerStores.values()) {
    try {
      store.getState().view?.renderer.setStyles?.(getStyles(updated));
    } catch (e) {
      console.warn("[managePreferences] 应用样式到打开的书籍失败:", e);
    }
  }
}

function getViewSettings() {
  return useAppSettingsStore.getState().settings.globalViewSettings;
}

function updateViewSettings(patch: Partial<ReturnType<typeof getViewSettings>>) {
  const { settings, setSettings } = useAppSettingsStore.getState();
  const updated = { ...settings.globalViewSettings, ...patch };
  setSettings({ ...settings, globalViewSettings: updated });
  applyToOpenReaders(updated);
  return updated;
}

export const managePreferencesTool = tool({
  description: `偏好设置：主题/明暗模式、阅读器偏好（字号/字体/行高/阅读背景）、界面偏好。

🎯 **核心功能**：
• action=setTheme：切换明暗模式（light/dark/auto）或更换全局主题（globalTheme 传主题文件名或显示名，支持模糊匹配；传 "default" 恢复默认主题）
• action=reader：调整阅读器偏好——fontSize（12-32 绝对值或 larger/smaller 步进 2）、fontName（内置预设或用户上传字体，模糊匹配）、lineHeight（1.0-3.0）、background（场景名 羊皮纸/星空/山脉/海滩/花卉 或 none 恢复默认纯色）
• action=ui：调整界面偏好——tabOrientation（vertical 竖排/horizontal 横排）、autoScroll（聊天自动滚动）、swapSidebars（阅读页聊天栏与笔记栏对调）

📋 **前提条件**：系统提示词的「可用全局主题」一节列出了当前全部主题；用户说的主题不在清单里时，先告知可选清单再让用户选择

📋 **说明**：同一 action 内的参数可任意组合，一次调用全部生效；已打开的书籍会实时应用新的阅读设置

📊 **返回内容**：
生效后的当前设置摘要`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    action: z.enum(["setTheme", "reader", "ui"]).describe("setTheme=主题/明暗模式, reader=阅读偏好, ui=界面偏好"),
    mode: z
      .enum(["light", "dark", "auto"])
      .optional()
      .describe("setTheme：明暗模式 light=浅色, dark=深色, auto=跟随系统"),
    globalTheme: z
      .string()
      .optional()
      .describe("setTheme：全局主题名称（文件名或显示名，可模糊匹配），传 'default' 恢复默认主题"),
    fontSize: z
      .union([z.number().min(FONT_SIZE_MIN).max(FONT_SIZE_MAX), z.enum(["larger", "smaller"])])
      .optional()
      .describe("reader：字号 12-32 的绝对值，或 larger/smaller 调大/调小一档"),
    fontName: z.string().optional().describe("reader：字体名称（内置预设或用户上传字体的名称，模糊匹配）"),
    lineHeight: z.number().min(1.0).max(3.0).optional().describe("reader：行高倍数（1.0-3.0，默认 1.6）"),
    background: z
      .string()
      .optional()
      .describe("reader：阅读背景场景名（羊皮纸/星空/山脉/海滩/花卉）或 none 恢复默认纯色"),
    tabOrientation: z
      .enum(["vertical", "horizontal"])
      .optional()
      .describe("ui：标签栏方向 vertical=竖排, horizontal=横排"),
    autoScroll: z.boolean().optional().describe("ui：聊天自动滚动到最新消息"),
    swapSidebars: z.boolean().optional().describe("ui：阅读页聊天栏与笔记栏位置对调"),
  }),

  execute: async ({
    reasoning,
    action,
    mode,
    globalTheme,
    fontSize,
    fontName,
    lineHeight,
    background,
    tabOrientation,
    autoScroll,
    swapSidebars,
  }: {
    reasoning: string;
    action: "setTheme" | "reader" | "ui";
    mode?: "light" | "dark" | "auto";
    globalTheme?: string;
    fontSize?: number | "larger" | "smaller";
    fontName?: string;
    lineHeight?: number;
    background?: string;
    tabOrientation?: "vertical" | "horizontal";
    autoScroll?: boolean;
    swapSidebars?: boolean;
  }) => {
    try {
      // ==================== 主题 / 明暗模式 ====================
      if (action === "setTheme") {
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
      }

      // ==================== 阅读偏好 ====================
      if (action === "reader") {
        const changes: string[] = [];
        const current = getViewSettings();

        // ---- 字号 / 字体 / 行高 ----
        const patch: Record<string, unknown> = {};

        if (fontSize !== undefined) {
          const next =
            fontSize === "larger"
              ? Math.min(FONT_SIZE_MAX, current.defaultFontSize + 2)
              : fontSize === "smaller"
                ? Math.max(FONT_SIZE_MIN, current.defaultFontSize - 2)
                : fontSize;
          patch.defaultFontSize = next;
          changes.push(`字号 ${current.defaultFontSize} → ${next}`);
        }

        if (fontName !== undefined) {
          const q = fontName.trim().toLowerCase();
          const curated = CURATED_FONTS.find(
            (f) => f.id.toLowerCase() === q || f.name.toLowerCase().includes(q) || f.nameEn.toLowerCase().includes(q),
          );
          if (curated) {
            patch.serifFont = curated.serif;
            patch.sansSerifFont = curated.sansSerif;
            patch.defaultCJKFont = curated.cjk;
            changes.push(`字体 → ${curated.name}`);
          } else {
            await useFontStore.getState().loadFonts();
            const custom = useFontStore
              .getState()
              .fonts.find(
                (f) =>
                  f.name.toLowerCase().includes(q) ||
                  f.displayName?.toLowerCase().includes(q) ||
                  f.fontFamily?.toLowerCase().includes(q),
              );
            if (!custom) {
              return {
                results: {
                  success: false,
                  message: `没有找到字体「${fontName}」。内置预设：${CURATED_FONTS.map((f) => f.name).join("、")}`,
                },
                meta: { reasoning },
              };
            }
            const family = custom.fontFamily || custom.name;
            patch.serifFont = family;
            patch.sansSerifFont = family;
            patch.defaultCJKFont = family;
            changes.push(`字体 → ${custom.displayName || custom.name}（自定义）`);
          }
        }

        if (lineHeight !== undefined) {
          patch.lineHeight = lineHeight;
          changes.push(`行高 ${current.lineHeight} → ${lineHeight}`);
        }

        let updated = current;
        if (Object.keys(patch).length > 0) {
          updated = updateViewSettings(patch as Partial<typeof current>);
        }

        // ---- 阅读背景 ----
        if (background !== undefined) {
          const q = background.trim().toLowerCase();
          const themeStore = useThemeStore.getState();
          if (q === "none" || q === "默认" || q === "纯色") {
            themeStore.setReaderBackground(null);
            changes.push("背景 → 默认纯色");
          } else {
            const scene = readerScenes.find((s) => s.id.toLowerCase() === q || s.label.toLowerCase().includes(q));
            if (!scene) {
              return {
                results: {
                  success: false,
                  message: `没有找到背景「${background}」。可用场景：${readerScenes.map((s) => s.label).join("、")}，或 none 恢复默认`,
                },
                meta: { reasoning },
              };
            }
            themeStore.setReaderBackground({ kind: "scene", sceneId: scene.id });
            changes.push(`背景 → ${scene.label}`);
          }
          // 背景选择是多端同步的偏好，推一份到云端（静默，不阻塞）
          void syncUiConfigNow();
        }

        if (changes.length === 0) {
          return {
            results: { success: false, message: "未指定任何调整项（fontSize / fontName / lineHeight / background）" },
            meta: { reasoning },
          };
        }

        return {
          results: {
            success: true,
            message: `已调整：${changes.join("；")}`,
            current: {
              fontSize: updated.defaultFontSize,
              lineHeight: updated.lineHeight,
              background: useThemeStore.getState().readerBackground?.sceneId ?? "默认纯色",
            },
          },
          meta: { reasoning },
        };
      }

      // ==================== 界面偏好 ====================
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
      throw new Error(`调整偏好失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
