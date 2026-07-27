import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { applySyncResult } from "@/services/apply-sync-result";
import { syncGetL2Status, syncRunNow } from "@/services/sync-service";
import { syncUiConfigNow } from "@/services/ui-config-sync";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/**
 * 全局同步刷新按钮（位于顶栏通知铃铛旁）
 * 增量同步开启时：触发一轮完整同步（推送本地变更 + 拉取远端变更），
 * 将结果应用到 UI（书架、对话列表、划线笔记、进度跳转、字体/背景资产），
 * 成功后自动整页重载（等同 Ctrl+R），让所有界面状态彻底重建。
 * 增量同步关闭/未配置时：退化为普通页面刷新，不报错。
 */
export default function SyncRefreshButton() {
  const [isSyncing, setIsSyncing] = useState(false);
  const queryClient = useQueryClient();

  const handleClick = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    try {
      const status = await syncGetL2Status().catch(() => null);
      if (!status?.enabled) {
        // 未开启增量同步：回退为普通刷新（Ctrl+R），不存在"失败"一说
        window.location.reload();
        return;
      }
      const result = await syncRunNow();
      await applySyncResult(result, queryClient);
      await syncUiConfigNow();
      toast.success("同步完成，即将刷新页面", { description: result.message });
      // 兼具 Ctrl+R：同步落账后整页重载，所有界面状态彻底归零重建
      setTimeout(() => window.location.reload(), 800);
    } catch (error) {
      console.error("同步失败:", error);
      toast.error("同步失败", { description: String(error) });
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
      <TooltipContent side="bottom">同步并刷新页面（未开启同步时仅刷新页面）</TooltipContent>
    </Tooltip>
  );
}
