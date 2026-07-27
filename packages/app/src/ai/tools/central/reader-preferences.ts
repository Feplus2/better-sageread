/**
 * 全局助手工具：阅读偏好设置（字号/字体/行高/阅读背景）
 *
 * 数据源：app-settings-store.globalViewSettings（字号/字体/行高）+ theme-store.readerBackground（背景）
 * 改动立即写入全局默认，并实时套用到所有已打开的书籍渲染器
 */
import { CURATED_FONTS } from "@/services/constants";
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

/** 把更新后的全局视图设置实时套用到所有打开的书籍渲染器 */
function applyToOpenReaders(updated: ReturnType<typeof getViewSettings>) {
  const { readerStores } = useLayoutStore.getState();
  for (const store of readerStores.values()) {
    try {
      store.getState().view?.renderer.setStyles?.(getStyles(updated));
    } catch (e) {
      console.warn("[readerPreferences] 应用样式到打开的书籍失败:", e);
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

export const readerPreferencesTool = tool({
  description: `调整阅读器偏好设置：字号、字体、行高、阅读背景。

🎯 **核心功能**：
• 字号：fontSize 传绝对值（12-32）或 "larger"/"smaller"（步进 2）
• 字体：fontName 模糊匹配内置字体预设（系统默认/寒蝉活宋体/经典衬线/现代无衬线/优雅楷体）或用户上传的自定义字体
• 行高：lineHeight（1.0-3.0，默认 1.6）
• 阅读背景：background 传场景名（羊皮纸/星空/山脉/海滩/花卉）或 "none" 恢复默认纯色

📋 **说明**：所有参数可任意组合，一次调用全部生效；已打开的书籍会实时应用新设置

📊 **返回内容**：
生效后的当前设置摘要`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    fontSize: z
      .union([z.number().min(FONT_SIZE_MIN).max(FONT_SIZE_MAX), z.enum(["larger", "smaller"])])
      .optional()
      .describe("字号：12-32 的绝对值，或 larger/smaller 调大/调小一档"),
    fontName: z.string().optional().describe("字体名称（内置预设或用户上传字体的名称，模糊匹配）"),
    lineHeight: z.number().min(1.0).max(3.0).optional().describe("行高倍数（1.0-3.0，默认 1.6）"),
    background: z.string().optional().describe("阅读背景：场景名（羊皮纸/星空/山脉/海滩/花卉）或 none 恢复默认纯色"),
  }),

  execute: async ({
    reasoning,
    fontSize,
    fontName,
    lineHeight,
    background,
  }: {
    reasoning: string;
    fontSize?: number | "larger" | "smaller";
    fontName?: string;
    lineHeight?: number;
    background?: string;
  }) => {
    try {
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
    } catch (error) {
      throw new Error(`调整阅读偏好失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
