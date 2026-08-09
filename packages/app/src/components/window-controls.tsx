import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getOSPlatform } from "@/utils/misc";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";

const win = getCurrentWindow();

export default function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    // 只在 Windows 平台显示窗口控制按钮
    const platform = getOSPlatform();
    setIsVisible(platform === "windows");

    if (platform === "windows") {
      // 获取初始最大化状态
      win.isMaximized().then(setIsMaximized);

      // 监听窗口状态变化
      const unlisten = win.onResized(() => {
        win.isMaximized().then(setIsMaximized);
      });

      return () => {
        unlisten.then((fn) => fn());
      };
    }
  }, []);

  const handleMinimize = () => {
    win.minimize();
  };

  const handleToggleMaximize = async () => {
    const maximized = await win.isMaximized();
    if (maximized) {
      await win.unmaximize();
    } else {
      await win.maximize();
    }
    setIsMaximized(!maximized);
  };

  const handleClose = () => {
    win.close();
  };

  if (!isVisible) {
    return null;
  }

  return (
    <div className="flex h-7 items-center">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleMinimize}
            className="flex h-7 w-8 items-center justify-center text-neutral-700 hover:bg-accent dark:text-neutral-400 dark:hover:bg-accent"
          >
            <Minus className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">最小化</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleToggleMaximize}
            className="flex h-7 w-8 items-center justify-center text-neutral-700 hover:bg-accent dark:text-neutral-400 dark:hover:bg-accent"
          >
            {isMaximized ? <Square className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{isMaximized ? "还原" : "最大化"}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleClose}
            className="flex h-7 w-8 items-center justify-center text-neutral-700 hover:bg-red-500 hover:text-white dark:text-neutral-400 dark:hover:bg-red-500 dark:hover:text-white"
          >
            <X className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">关闭</TooltipContent>
      </Tooltip>
    </div>
  );
}
