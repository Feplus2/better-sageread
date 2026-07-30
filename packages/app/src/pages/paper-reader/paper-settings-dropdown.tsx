import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FontSizeSlider } from "@/pages/reader/components/font-size-slider";
import { CURATED_FONTS, DEFAULT_BOOK_FONT } from "@/services/constants";
import { useAppSettingsStore } from "@/store/app-settings-store";
import { useFontStore } from "@/store/font-store";
import { isCJKEnv } from "@/utils/misc";
import { Settings2 } from "lucide-react";
import { useEffect, useMemo } from "react";

const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 32;
const FONT_SIZE_STEP = 2;

interface PaperSettingsDropdownProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 论文设置下拉：字体系列（含自定义字体）+ 字号滑块，结构与书籍 SettingsDropdown 一致。
 * 与书籍版的唯一差别：论文没有 foliate renderer，只写 settings.globalViewSettings
 * （书籍阅读器共享同一 store，设置天然联动）。
 */
export default function PaperSettingsDropdown({ open, onOpenChange }: PaperSettingsDropdownProps) {
  const { settings, setSettings } = useAppSettingsStore();
  const { fonts: customFontList, loadFonts } = useFontStore();
  const globalViewSettings = settings.globalViewSettings;

  const customFonts = useMemo(
    () =>
      customFontList.map((font) => {
        const fontFamily = font.fontFamily || font.name;
        return {
          id: `custom-${font.name}`,
          name: font.displayName || font.name,
          serif: fontFamily,
          sansSerif: fontFamily,
          cjk: fontFamily,
        };
      }),
    [customFontList],
  );

  const allFonts = useMemo(() => [...CURATED_FONTS, ...customFonts], [customFonts]);

  useEffect(() => {
    loadFonts();
  }, [loadFonts]);

  // 当前选用的字体被删除（自定义字体移除）时回落默认（同书籍 SettingsDropdown）
  useEffect(() => {
    const currentFontExists = allFonts.some(
      (font) =>
        font.serif === globalViewSettings.serifFont &&
        font.sansSerif === globalViewSettings.sansSerifFont &&
        font.cjk === globalViewSettings.defaultCJKFont,
    );

    if (!currentFontExists && customFonts.length > 0) {
      const { settings: currentSettings } = useAppSettingsStore.getState();
      setSettings({
        ...currentSettings,
        globalViewSettings: {
          ...currentSettings.globalViewSettings,
          serifFont: DEFAULT_BOOK_FONT.serifFont,
          sansSerifFont: DEFAULT_BOOK_FONT.sansSerifFont,
          defaultCJKFont: DEFAULT_BOOK_FONT.defaultCJKFont,
        },
      });
    }
  }, [allFonts, customFonts.length, globalViewSettings, setSettings]);

  const currentFontId =
    allFonts.find(
      (font) =>
        font.serif === globalViewSettings.serifFont &&
        font.sansSerif === globalViewSettings.sansSerifFont &&
        font.cjk === globalViewSettings.defaultCJKFont,
    )?.id || "comfortable";

  // 只写 store，不调 foliate renderer.setStyles（论文无 renderer；书籍阅读器经共享 store 联动）
  const updateGlobalViewSettings = (updater: (settings: typeof globalViewSettings) => typeof globalViewSettings) => {
    const { settings: currentSettings } = useAppSettingsStore.getState();
    setSettings({
      ...currentSettings,
      globalViewSettings: updater(currentSettings.globalViewSettings),
    });
  };

  const handleFontChange = (fontId: string) => {
    const selectedFont = allFonts.find((f) => f.id === fontId);
    if (!selectedFont) return;
    updateGlobalViewSettings((settings) => ({
      ...settings,
      serifFont: selectedFont.serif,
      sansSerifFont: selectedFont.sansSerif,
      defaultCJKFont: selectedFont.cjk,
    }));
  };

  const handleFontSizeChange = (newSize: number) => {
    const clampedSize = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, newSize));
    updateGlobalViewSettings((settings) => ({ ...settings, defaultFontSize: clampedSize }));
  };

  const isCJK = isCJKEnv();

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button className="btn btn-ghost flex h-8 min-h-8 w-8 items-center justify-center rounded-full p-0 outline-none focus:outline-none focus-visible:ring-0">
              <Settings2 size={18} />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">字体大小设置</TooltipContent>
      </Tooltip>
      <DropdownMenuContent className="w-80 p-3" align="end" side="bottom" sideOffset={4}>
        <div className="space-y-4">
          <div>
            <div className="mb-3 font-medium text-sm">字体系列</div>
            {(() => {
              const selected = allFonts.find((f) => f.id === currentFontId);
              const triggerFontFamily = selected ? (isCJK ? selected.cjk : selected.serif) : undefined;
              const triggerFontWeight = selected?.id === "classic" ? "normal" : (undefined as any);
              return (
                <Select value={currentFontId} onValueChange={handleFontChange}>
                  <SelectTrigger
                    className="h-8 w-full focus:outline-none focus:ring-0"
                    style={{ fontFamily: triggerFontFamily, fontWeight: triggerFontWeight }}
                  >
                    <SelectValue placeholder="选择字体" />
                  </SelectTrigger>
                  <SelectContent className="w-full dark:border-neutral-700 dark:bg-neutral-800">
                    {allFonts.map((font) => (
                      <SelectItem key={font.id} value={font.id}>
                        <span
                          className="truncate"
                          style={{
                            fontFamily: isCJK ? font.cjk : font.serif,
                            fontWeight: font.id === "classic" ? "normal" : (undefined as any),
                          }}
                        >
                          {font.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              );
            })()}
          </div>

          <div>
            <div className="mb-3 font-medium text-sm">字体大小</div>
            <div className="flex items-center justify-center gap-4">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="btn btn-sm size-8 cursor-pointer rounded-md border bg-muted hover:bg-muted/70 disabled:bg-muted disabled:opacity-50"
                    onClick={() => handleFontSizeChange(globalViewSettings.defaultFontSize - FONT_SIZE_STEP)}
                    disabled={globalViewSettings.defaultFontSize <= FONT_SIZE_MIN}
                  >
                    <span className="flex items-center justify-center text-xs">A</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">减小字体大小</TooltipContent>
              </Tooltip>

              <FontSizeSlider
                value={[globalViewSettings.defaultFontSize]}
                onValueChange={(value: number[]) => handleFontSizeChange(value[0]!)}
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                step={FONT_SIZE_STEP}
                showTooltip={true}
                tooltipContent={(value) => `${value}px`}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="btn btn-sm size-8 cursor-pointer rounded-md border bg-muted hover:bg-muted/70 disabled:bg-muted disabled:opacity-50"
                    onClick={() => handleFontSizeChange(globalViewSettings.defaultFontSize + FONT_SIZE_STEP)}
                    disabled={globalViewSettings.defaultFontSize >= FONT_SIZE_MAX}
                  >
                    <span className="flex items-center justify-center text-lg">A</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">增大字体大小</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
