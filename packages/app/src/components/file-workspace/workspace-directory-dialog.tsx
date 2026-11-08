import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { open as openDirectory } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";

export type TaskWorkspaceMode = "once" | "remember";

interface WorkspaceDirectoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  initialPath: string;
  recentPaths?: string[];
  mode?: "preview" | "task";
  defaultMode?: TaskWorkspaceMode;
  onSubmit: (path: string, mode: TaskWorkspaceMode) => void | Promise<void>;
  onReset?: () => void | Promise<void>;
}

export function WorkspaceDirectoryDialog({
  open,
  onOpenChange,
  title,
  initialPath,
  recentPaths = [],
  mode = "preview",
  defaultMode = "remember",
  onSubmit,
  onReset,
}: WorkspaceDirectoryDialogProps) {
  const [path, setPath] = useState(initialPath);
  const [persistence, setPersistence] = useState<TaskWorkspaceMode>(defaultMode);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPath(initialPath);
    setPersistence(defaultMode);
    setError("");
    setBusy(false);
  }, [open, initialPath, defaultMode]);

  const browse = async () => {
    setBusy(true);
    setError("");
    try {
      const selected = await openDirectory({
        directory: true,
        multiple: false,
        title,
        defaultPath: path.trim() || undefined,
      });
      if (typeof selected === "string" && selected.trim()) setPath(selected);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = path.trim();
    if (!value) {
      setError("目录路径不能为空");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSubmit(value, persistence);
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!onReset) return;
    setBusy(true);
    setError("");
    try {
      await onReset();
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader className="px-4">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form className="space-y-4 px-4 pb-4" onSubmit={(event) => void submit(event)} noValidate>
          <DialogDescription className="px-0 text-muted-foreground text-xs leading-5">
            {mode === "task"
              ? "选择任务目录不等于授予写入权限；Agent 的实际写入仍走现有权限确认。"
              : "只读取已存在的目录。预览位置不会自动获得写入权限，敏感路径与界外授权仍然有效。"}
          </DialogDescription>
          <div className="space-y-2">
            <Label htmlFor="workspace-directory-path">目录路径</Label>
            <div className="flex gap-2">
              <Input
                id="workspace-directory-path"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="输入或粘贴目录路径"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
              <Button type="button" variant="outline" onClick={() => void browse()} disabled={busy}>
                <FolderOpen className="size-4" />
                系统目录选择…
              </Button>
            </div>
          </div>
          {recentPaths.length > 0 && (
            <div className="space-y-1">
              <div className="flex justify-between text-muted-foreground text-xs">
                <span>最近位置</span>
                <span>仅此助手</span>
              </div>
              <div className="max-h-32 space-y-0.5 overflow-y-auto">
                {recentPaths.map((recent) => (
                  <button
                    key={recent}
                    type="button"
                    onClick={() => setPath(recent)}
                    className="block w-full truncate rounded-md px-2 py-1.5 text-left font-mono text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
                  >
                    {recent}
                  </button>
                ))}
              </div>
            </div>
          )}
          {mode === "task" && (
            <fieldset className="space-y-2">
              <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm has-checked:border-primary has-checked:bg-muted/60">
                <input
                  type="radio"
                  name="workspace-mode"
                  value="once"
                  checked={persistence === "once"}
                  onChange={() => setPersistence("once")}
                  disabled={busy}
                />
                <span>
                  <span className="block font-medium">仅本次任务</span>
                  <span className="block text-muted-foreground text-xs">新对话恢复默认，不改变其他助手</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm has-checked:border-primary has-checked:bg-muted/60">
                <input
                  type="radio"
                  name="workspace-mode"
                  value="remember"
                  checked={persistence === "remember"}
                  onChange={() => setPersistence("remember")}
                  disabled={busy}
                />
                <span>
                  <span className="block font-medium">记住为此助手的默认</span>
                  <span className="block text-muted-foreground text-xs">只记忆当前助手，不全局替换共享工作区</span>
                </span>
              </label>
            </fieldset>
          )}
          {error && (
            <p className="break-words text-red-600 text-xs dark:text-red-400" role="alert">
              {error}
            </p>
          )}
          <div className="flex items-center justify-between gap-2 border-t pt-3">
            <div>
              {onReset && (
                <Button type="button" variant="ghost" onClick={() => void reset()} disabled={busy}>
                  恢复共享工作区
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                {mode === "task" ? "保存选择" : "打开目录"}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
