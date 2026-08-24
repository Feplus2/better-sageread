import { Markdown } from "@/components/prompt-kit/markdown";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useUpdateStore } from "@/store/update-store";

/** 更新确认框（全局挂载于 ReaderLayout）：设置页手动「检查更新」发现新版本时弹出，
 *  展示版本号与更新说明；「立即更新」才下载安装，「以后再说」跳过；下载中禁止关闭防误触。
 *  启动不做自动检查（用户拍板：不打扰优先）。
 *  更新说明经对话同款 Markdown 渲染（chat-md/prose 主题跟随），按钮区按对话框规范留白 */
export function UpdateConfirmDialog() {
  const pendingUpdate = useUpdateStore((s) => s.pendingUpdate);
  const isUpdating = useUpdateStore((s) => s.isUpdating);
  const confirmUpdate = useUpdateStore((s) => s.confirmUpdate);
  const dismissUpdate = useUpdateStore((s) => s.dismissUpdate);

  // 更新说明正文剥掉首行 H1（就是「Better SageRead vX.Y.Z — 主题」，与对话框标题重复）
  const notesBody = pendingUpdate?.body?.replace(/^\s*#[^\n]*(?:\n+|$)/, "");

  return (
    <Dialog
      open={!!pendingUpdate}
      onOpenChange={(open) => {
        if (!open) dismissUpdate();
      }}
    >
      <DialogContent className="flex max-h-[80vh] max-w-lg flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>发现新版本 v{pendingUpdate?.version}</DialogTitle>
        </DialogHeader>
        {notesBody && (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <Markdown className="chat-md prose text-foreground text-sm">{notesBody}</Markdown>
          </div>
        )}
        <DialogFooter className="flex-shrink-0 border-neutral-200 border-t pt-3 dark:border-neutral-700">
          <Button variant="outline" onClick={dismissUpdate} disabled={isUpdating}>
            以后再说
          </Button>
          <Button onClick={() => void confirmUpdate()} disabled={isUpdating} className="min-w-24">
            {isUpdating ? (
              <div className="flex items-center gap-2">
                <div className="h-4 w-4 animate-spin rounded-full border border-white/30 border-t-white" />
                下载中...
              </div>
            ) : (
              "立即更新"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
