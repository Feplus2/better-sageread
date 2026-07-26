import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { applySyncResult } from "@/services/apply-sync-result";
import { syncRunNow } from "@/services/sync-service";
import { syncUiConfigNow } from "@/services/ui-config-sync";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/**
 * 全局同步刷新按钮（位于顶栏通知铃铛旁）
 * 触发一轮完整 L2 同步（推送本地变更 + 拉取远端变更），并将结果应用到 UI：
 * 书架、对话列表、划线笔记、进度跳转、字体/背景资产
 */
export default function SyncRefreshButton() {
  const [isSyncing, setIsSyncing] = useState(false);
  const queryClient = useQueryClient();

  const handleClick = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    try {
      const result = await syncRunNow();
      await applySyncResult(result, queryClient);
      void syncUiConfigNow();
      toast.success("同步完成", { description: result.message });
    } catch (error) {
      console.error("同步失败:", error);
      toast.error("同步失败", { description: String(error) });
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={handleClick}
          disabled={isSyncing}
          className="flex h-6 w-6 items-center justify-center rounded-full outline-none hover:bg-neutral-200 focus:outline-none focus-visible:ring-0 disabled:opacity-50 dark:hover:bg-neutral-700"
        >
          <RefreshCw size={18} className={isSyncing ? "animate-spin" : ""} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">同步刷新（推送并拉取所有设备的最新变更）</TooltipContent>
    </Tooltip>
  );
}
