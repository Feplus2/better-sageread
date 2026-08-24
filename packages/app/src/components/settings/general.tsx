import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getUserThemesDir } from "@/services/global-theme-service";
import { useAppSettingsStore } from "@/store/app-settings-store";
import { useThemeStore } from "@/store/theme-store";
import { useUpdateStore } from "@/store/update-store";
import type { ThemeMode } from "@/styles/themes";
import type { MotionModeType } from "@/types/settings";
import { getVersion } from "@tauri-apps/api/app";
import { appDataDir } from "@tauri-apps/api/path";
import { exists, mkdir } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import clsx from "clsx";
import { Check, ChevronDownIcon, Copy, FolderOpen, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export default function GeneralSettings() {
  const [dataPath, setDataPath] = useState("");
  const [isCopied, setIsCopied] = useState(false);
  const [appVersion, setAppVersion] = useState("0.1.0");
  // 更新检查/确认框状态收编 update-store（确认框全局挂载于 ReaderLayout；仅手动触发，启动不自动检查）
  const isCheckingUpdate = useUpdateStore((s) => s.isChecking);
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates);
  const availableUpdate = useUpdateStore((s) => s.availableUpdate);

  const { themeMode, autoScroll, swapSidebars, setThemeMode, setAutoScroll, setSwapSidebars } = useThemeStore();
  const { globalTheme, availableGlobalThemes, setGlobalTheme, refreshGlobalThemes, reloadGlobalThemes } =
    useThemeStore();
  // 动效模式三档（motion token 体系，use-motion-mode 驱动 <html data-motion> 即时生效）
  const { settings, setSettings } = useAppSettingsStore();
  const motionMode: MotionModeType = settings.motionMode ?? "full";
  const motionModeOptions = [
    { value: "full" as MotionModeType, label: "完整动效" },
    { value: "fade-only" as MotionModeType, label: "仅淡入淡出" },
    { value: "system" as MotionModeType, label: "遵循系统" },
  ];

  // 进入设置页时扫描一次主题列表（内置 + 用户主题文件夹；仅扫描不重注入，避免全局重渲染）
  useEffect(() => {
    refreshGlobalThemes();
  }, [refreshGlobalThemes]);

  const currentGlobalTheme = availableGlobalThemes.find((t) => t.name === globalTheme);
  const globalThemeLabel = !globalTheme
    ? "默认"
    : currentGlobalTheme
      ? `${currentGlobalTheme.label ?? currentGlobalTheme.name}${currentGlobalTheme.source === "user" ? "（自定义）" : ""}`
      : globalTheme;

  const handleGlobalThemeChange = async (name: string | null) => {
    try {
      await setGlobalTheme(name);
    } catch (error) {
      console.error("切换全局主题失败:", error);
      toast.error("切换全局主题失败");
    }
  };

  const handleOpenThemesFolder = async () => {
    try {
      await openPath(await getUserThemesDir());
    } catch (error) {
      console.error("打开主题文件夹失败:", error);
      toast.error("打开主题文件夹失败");
    }
  };

  const handleRefreshThemes = async () => {
    await reloadGlobalThemes();
    toast.success("主题列表已刷新");
  };

  const themeModeOptions = [
    { value: "auto" as ThemeMode, label: "系统" },
    { value: "light" as ThemeMode, label: "亮色" },
    { value: "dark" as ThemeMode, label: "暗色" },
  ];

  useEffect(() => {
    appDataDir().then(async (path) => {
      setDataPath(path);
      try {
        const appDataDirPath = await appDataDir();
        const directoryExists = await exists(appDataDirPath);

        if (!directoryExists) {
          await mkdir(appDataDirPath, { recursive: true });
        }
      } catch (error) {
        console.error("An error occurred:", error);
      }
    });

    getVersion().then(setAppVersion).catch(console.error);
  }, []);

  const handleShowInFinder = async () => {
    try {
      await openPath(dataPath);
    } catch (error) {
      console.error("Failed to open in Finder:", error);
    }
  };

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(dataPath);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy:", error);
    }
  };

  // 手动检查更新（设置页按钮）：走 update-store 统一路径——确认框全局挂载；已最新/失败如实 toast
  const handleCheckForUpdates = async () => {
    await checkForUpdates();
  };

  const handleThemeModeChange = (mode: ThemeMode) => {
    setThemeMode(mode);
  };

  const getCurrentThemeModeLabel = () => {
    return themeModeOptions.find((option) => option.value === themeMode)?.label || "系统";
  };

  return (
    <div className="space-y-8 p-4 pt-3">
      <section className="rounded-lg bg-muted/80 p-4">
        <h2 className="text mb-4 dark:text-neutral-200">关于</h2>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text dark:text-neutral-200">应用版本</span>
            <p className=" text-neutral-600 text-xs dark:text-neutral-400">v{appVersion}</p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <span className="text dark:text-neutral-200">检查更新</span>
              <p className="mt-2 text-neutral-600 text-xs dark:text-neutral-400">
                {availableUpdate ? `有新版本可用：v${availableUpdate.version}` : "检查是否有新版本可用"}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={handleCheckForUpdates}
              disabled={isCheckingUpdate}
              className="relative gap-2"
            >
              <RefreshCw className={clsx("size-4", isCheckingUpdate && "animate-spin")} />
              {isCheckingUpdate ? "检查中..." : "检查更新"}
              {availableUpdate && !isCheckingUpdate && (
                <span className="-top-1 -right-1 absolute h-2.5 w-2.5 rounded-full bg-red-500" />
              )}
            </Button>
          </div>

          <div className="border-neutral-200 border-t pt-4 dark:border-neutral-700">
            <span className="text dark:text-neutral-200">Better SageRead</span>
            <p className="mt-2 text-neutral-600 text-xs leading-relaxed dark:text-neutral-400">
              基于 xincmm 的开源项目{" "}
              <a href="https://github.com/xincmm/sageread" className="text-primary underline underline-offset-2">
                SageRead
              </a>{" "}
              发展而来，原作者奠定了核心框架，在此致谢。
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-lg bg-muted/80 p-4">
        <h2 className="text mb-4 dark:text-neutral-200">外观</h2>
        <div className="space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <span className="text dark:text-neutral-200">明暗模式</span>
              <p className="mt-2 text-neutral-600 text-xs dark:text-neutral-400">选择明暗模式偏好</p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="w-32 justify-between">
                  {getCurrentThemeModeLabel()}
                  <ChevronDownIcon className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-32">
                {themeModeOptions.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    onClick={() => handleThemeModeChange(option.value)}
                    className={clsx("my-0.5", themeMode === option.value ? "bg-accent" : "")}
                  >
                    {option.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="flex items-start justify-between">
            <div>
              <span className="text dark:text-neutral-200">全局主题</span>
              <p className="mt-2 text-neutral-600 text-xs dark:text-neutral-400">
                自定义应用界面外观，不影响书籍内部配色
              </p>
            </div>
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" className="w-36 justify-between">
                    <span className="truncate">{globalThemeLabel}</span>
                    <ChevronDownIcon className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-36">
                  <DropdownMenuItem
                    onClick={() => handleGlobalThemeChange(null)}
                    className={clsx("my-0.5", globalTheme === null ? "bg-accent" : "")}
                  >
                    默认
                  </DropdownMenuItem>
                  {availableGlobalThemes.map((theme) => (
                    <DropdownMenuItem
                      key={`${theme.source}-${theme.name}`}
                      onClick={() => handleGlobalThemeChange(theme.name)}
                      className={clsx("my-0.5", globalTheme === theme.name ? "bg-accent" : "")}
                    >
                      {theme.label ?? theme.name}
                      {theme.source === "user" ? "（自定义）" : ""}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" variant="outline" className="size-8 p-0" onClick={handleOpenThemesFolder}>
                    <FolderOpen className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">打开主题文件夹</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" variant="outline" className="size-8 p-0" onClick={handleRefreshThemes}>
                    <RefreshCw className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">刷新主题列表</TooltipContent>
              </Tooltip>
            </div>
          </div>

          <div className="flex items-start justify-between">
            <div>
              <span className="text dark:text-neutral-200">动效模式</span>
              <p className="mt-2 text-neutral-600 text-xs dark:text-neutral-400">
                低配设备可选「仅淡入淡出」，位移/缩放动效退化为淡入淡出
              </p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="w-32 justify-between">
                  {motionModeOptions.find((option) => option.value === motionMode)?.label ?? "完整动效"}
                  <ChevronDownIcon className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-32">
                {motionModeOptions.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    onClick={() => setSettings({ ...settings, motionMode: option.value })}
                    className={clsx("my-0.5", motionMode === option.value ? "bg-accent" : "")}
                  >
                    {option.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <span className="text dark:text-neutral-200">自动滚动</span>
              <p className="mt-2 text-neutral-600 text-xs dark:text-neutral-400">聊天时自动滚动到最新消息</p>
            </div>
            <Checkbox
              checked={autoScroll}
              onCheckedChange={(checked) => setAutoScroll(checked === true)}
              className="data-[state=checked]:border-primary data-[state=checked]:bg-primary"
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <span className="text dark:text-neutral-200">对调侧边栏</span>
              <p className="mt-2 text-neutral-600 text-xs dark:text-neutral-400">将聊天和笔记侧边栏位置对调</p>
            </div>
            <Checkbox
              checked={swapSidebars}
              onCheckedChange={(checked) => setSwapSidebars(checked === true)}
              className="data-[state=checked]:border-primary data-[state=checked]:bg-primary"
            />
          </div>
        </div>
      </section>

      <section className="rounded-lg bg-muted/80 p-4">
        <h2 className="text mb-4 dark:text-neutral-200">数据文件夹</h2>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <span className="text-sm dark:text-neutral-200">应用数据</span>
              <div className="mt-2 flex items-center gap-2">
                <span className="rounded bg-background px-2 py-1 text-sm dark:bg-neutral-700 dark:text-neutral-300">
                  {dataPath}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button size="sm" variant="soft" onClick={handleCopyPath} className="size-6 p-0">
                      {isCopied ? <Check className="size-3 text-green-500" /> : <Copy className="size-3" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">复制路径</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button size="sm" variant="soft" onClick={handleShowInFinder} className="size-6 p-0">
                      <FolderOpen className="size-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">打开数据文件夹</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>
        </div>
      </section>
      {/* 更新确认框全局挂载于 ReaderLayout（update-confirm-dialog.tsx），设置页不重复挂 */}
    </div>
  );
}
