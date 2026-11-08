import { type ChangedFile, collectChangedFiles } from "@/ai/utils/changed-files";
import { collectPresentedFiles } from "@/ai/utils/presented-files";
import { cn } from "@/lib/utils";
import { ChevronDown, FileText } from "lucide-react";
import { useMemo, useState } from "react";

interface ChangedFilesDisclosureProps {
  message: { id: string; parts: Array<Record<string, any>> };
  onOpenFile: (file: { path: string; title?: string }) => void;
}

function fileName(path: string) {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path
  );
}

export function ChangedFilesDisclosure({ message, onOpenFile }: ChangedFilesDisclosureProps) {
  const [open, setOpen] = useState(false);
  const files = useMemo(() => collectChangedFiles([message]), [message]);
  const presented = useMemo(() => collectPresentedFiles(message), [message]);
  if (files.length === 0 && presented.length === 0) return null;
  return (
    <section
      data-region="changed-files"
      data-message-files={message.id}
      className="mt-2 min-w-0 shrink-0 rounded-lg border border-border/70 bg-muted/20 px-2 py-1"
    >
      {presented.length > 0 && (
        <div data-region="presented-files" aria-label="本轮交付文件" className="grid gap-1.5 py-1.5">
          {presented.map((file) => (
            <article
              key={file.path}
              className="min-w-0 rounded-md border border-border bg-card px-2 py-1.5 transition-colors focus-within:bg-accent hover:bg-accent"
            >
              <button
                type="button"
                data-file-path={file.path}
                onClick={() => onOpenFile(file)}
                className="flex w-full items-center gap-2 rounded text-left text-xs"
                title={file.path}
              >
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{fileName(file.path)}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">交付</span>
              </button>
              {file.description && (
                <p className="mt-0.5 truncate pl-6 text-[11px] text-muted-foreground" title={file.description}>
                  {file.description}
                </p>
              )}
            </article>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-label={`已编辑 ${files.length} 个文件`}
            onClick={() => setOpen((value) => !value)}
            className="flex h-7 w-full items-center gap-1.5 rounded-md px-1 text-left text-muted-foreground text-xs hover:bg-accent"
          >
            <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
            <span>已编辑 {files.length} 个文件</span>
          </button>
          {open && (
            <div className="mb-1 max-h-32 space-y-0.5 overflow-y-auto">
              {files.map((file: ChangedFile) => (
                <button
                  key={file.path}
                  type="button"
                  data-file-path={file.path}
                  onClick={() => onOpenFile(file)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-muted-foreground text-xs hover:bg-accent"
                  title={file.path}
                >
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{fileName(file.path)}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {file.kind === "deleted"
                      ? "已删除"
                      : file.source === "runCommand"
                        ? "命令产物"
                        : file.source === "editFile"
                          ? "已编辑"
                          : "已写入"}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
