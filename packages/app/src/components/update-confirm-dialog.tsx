import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useUpdateStore } from "@/store/update-store";

/** 更新确认框（全局挂载于 ReaderLayout）：发现新版本展示版本号与更新说明，
 *  「立即更新」才下载安装，「以后再说」跳过；下载中禁止关闭防误触 */
export function UpdateConfirmDialog() {
  const pendingUpdate = useUpdateStore((s) => s.pendingUpdate);
  const isUpdating = useUpdateStore((s) => s.isUpdating);
  const confirmUpdate = useUpdateStore((s) => s.confirmUpdate);
  const dismissUpdate = useUpdateStore((s) => s.dismissUpdate);

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
        {pendingUpdate?.body && (
          <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-neutral-600 text-sm dark:text-neutral-400">
            {pendingUpdate.body}
          </div>
        )}
        <div className="flex flex-shrink-0 justify-end gap-3">
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
