import { CsvPreview } from "@/components/file-workspace/csv-preview";
import { SafeHtmlPreview } from "@/components/file-workspace/safe-html-preview";
import { WorkspaceMarkdown } from "@/components/file-workspace/workspace-markdown";
import { CodeBlockCode } from "@/components/prompt-kit/code-block";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  WORKSPACE_PREVIEW_CHUNK_BYTES,
  type WorkspaceStat,
  readWorkspaceChunk,
  readWorkspaceImage,
  statWorkspaceFile,
  workspaceFileUrl,
} from "@/services/agent-workspace-files";
import type { FileTabDescriptor } from "@/store/file-workspace-store";
import { useThemeStore } from "@/store/theme-store";
import { AlertTriangle, FileQuestion, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);
const TEXT_EXTENSIONS = new Set([
  "txt",
  "log",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "js",
  "jsx",
  "ts",
  "tsx",
  "css",
  "html",
  "htm",
  "xml",
  "yaml",
  "yml",
  "toml",
  "rs",
  "py",
  "java",
  "c",
  "cpp",
  "h",
  "cs",
  "go",
  "rb",
  "php",
  "sh",
  "sql",
]);

const CODE_LANGUAGES: Record<string, string> = {
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  json: "json",
  jsonl: "jsonl",
  css: "css",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  rs: "rust",
  py: "python",
  java: "java",
  c: "c",
  cpp: "cpp",
  h: "c",
  cs: "csharp",
  go: "go",
  rb: "ruby",
  php: "php",
  sh: "bash",
  sql: "sql",
  html: "html",
  htm: "html",
};
const CODE_EXTENSIONS = new Set(Object.keys(CODE_LANGUAGES));

function extensionOf(path: string): string {
  return path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() ?? "";
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

interface FilePreviewProps {
  tab: FileTabDescriptor;
  refreshToken: number;
  onRefresh: () => void;
}

export function FilePreview({ tab, refreshToken, onRefresh }: FilePreviewProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "deleted" | "binary">("loading");
  const [error, setError] = useState("");
  const [stat, setStat] = useState<WorkspaceStat | null>(null);
  const [chunks, setChunks] = useState<string[]>([]);
  const [nextOffset, setNextOffset] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [mediaUrl, setMediaUrl] = useState("");
  const [stale, setStale] = useState(false);
  const [htmlMode, setHtmlMode] = useState<"preview" | "code">("preview");
  const requestRef = useRef(0);
  const extension = extensionOf(tab.path);
  const isHtml = extension === "html" || extension === "htm";
  const isDarkMode = useThemeStore((state) => state.isDarkMode);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tab.path 用于切换文件时恢复默认预览模式
  useEffect(() => setHtmlMode("preview"), [tab.path]);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setStatus("loading");
    setError("");
    setStale(false);
    setChunks([]);
    setMediaUrl("");
    try {
      const nextStat = await statWorkspaceFile(tab.scope, tab.path, { rootResolved: tab.rootResolved });
      if (request !== requestRef.current) return;
      setStat(nextStat);
      if (!nextStat.exists) {
        setStatus("deleted");
        return;
      }
      if (nextStat.isDirectory) throw new Error("当前标签指向的是目录，请从文件资源管理器进入");
      if (IMAGE_EXTENSIONS.has(extension) || extension === "svg" || extension === "pdf") {
        const url =
          extension === "svg" || extension === "pdf"
            ? await workspaceFileUrl(tab.scope, tab.path, { rootResolved: tab.rootResolved })
            : (await readWorkspaceImage(tab.scope, tab.path, { rootResolved: tab.rootResolved })).dataUrl;
        if (request !== requestRef.current) {
          if (url.startsWith("blob:")) URL.revokeObjectURL(url);
          return;
        }
        setMediaUrl(url);
        setStatus("ready");
        return;
      }
      if (!TEXT_EXTENSIONS.has(extension) && !MARKDOWN_EXTENSIONS.has(extension)) {
        setStatus("binary");
        return;
      }
      const chunk = await readWorkspaceChunk(tab.scope, tab.path, 0, WORKSPACE_PREVIEW_CHUNK_BYTES, {
        rootResolved: tab.rootResolved,
      });
      if (request !== requestRef.current) return;
      if (chunk.binary) {
        setStatus("binary");
        return;
      }
      if (
        chunk.resolved !== nextStat.resolved ||
        chunk.totalSize !== nextStat.size ||
        chunk.modifiedMs !== nextStat.modifiedMs
      ) {
        setStale(true);
      }
      setChunks([chunk.content]);
      setNextOffset(chunk.nextOffset);
      setTruncated(chunk.truncated);
      setStatus("ready");
    } catch (reason) {
      if (request !== requestRef.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setStatus("error");
    }
  }, [extension, tab.path, tab.scope, tab.rootResolved]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken 与 load 共同触发当前文件的真实重读
  useEffect(() => {
    void load();
    return () => {
      requestRef.current++;
    };
  }, [load, refreshToken]);

  useEffect(
    () => () => {
      if (mediaUrl.startsWith("blob:")) URL.revokeObjectURL(mediaUrl);
    },
    [mediaUrl],
  );

  useEffect(() => {
    const checkExternal = async () => {
      if (!stat) return;
      const request = requestRef.current;
      const snapshot = stat;
      try {
        const current = await statWorkspaceFile(tab.scope, tab.path, { rootResolved: tab.rootResolved });
        if (request !== requestRef.current || snapshot !== stat) return;
        if (!current.exists) {
          setStatus("deleted");
          return;
        }
        if (
          current.resolved !== stat.resolved ||
          current.isDirectory ||
          current.modifiedMs !== stat.modifiedMs ||
          current.size !== stat.size
        ) {
          setStale(true);
        }
      } catch {
        // 保留当前已读内容，下轮手动刷新再显示具体错误。
      }
    };
    window.addEventListener("focus", checkExternal);
    return () => window.removeEventListener("focus", checkExternal);
  }, [stat, tab.path, tab.scope, tab.rootResolved]);

  const loadMore = async () => {
    if (!stat || !truncated) return;
    const snapshot = stat;
    const request = ++requestRef.current;
    setError("");
    try {
      const chunk = await readWorkspaceChunk(tab.scope, tab.path, nextOffset, WORKSPACE_PREVIEW_CHUNK_BYTES, {
        rootResolved: tab.rootResolved,
      });
      if (request !== requestRef.current) return;
      if (chunk.binary) {
        setError("此文件不是可预览的 UTF-8 文本");
        return;
      }
      if (
        chunk.resolved !== snapshot.resolved ||
        chunk.totalSize !== snapshot.size ||
        chunk.modifiedMs !== snapshot.modifiedMs
      ) {
        setStale(true);
        return;
      }
      setChunks((previous) => [...previous, chunk.content]);
      setNextOffset(chunk.nextOffset);
      setTruncated(chunk.truncated);
    } catch (reason) {
      if (request === requestRef.current) setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const content = useMemo(() => chunks.join(""), [chunks]);
  const renderedText = useMemo(() => {
    if (extension !== "json" || truncated) return content;
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return content;
    }
  }, [content, extension, truncated]);
  const richDocument = MARKDOWN_EXTENSIONS.has(extension) || isHtml;
  const richPreviewAllowed = !truncated && (stat?.size ?? 0) <= WORKSPACE_PREVIEW_CHUNK_BYTES;
  const boundedText = richDocument && !richPreviewAllowed;

  return (
    <section
      className="flex h-full min-h-0 flex-1 flex-col"
      data-region="file-preview"
      data-status={status}
      data-truncated={truncated}
      data-rich-preview={boundedText ? "bounded-text" : undefined}
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-neutral-200 border-b px-3 text-neutral-500 text-xs dark:border-neutral-700">
        <span className="min-w-0 flex-1 truncate" title={tab.path}>
          {tab.path}
        </span>
        {isHtml && richPreviewAllowed && (
          <div
            role="group"
            aria-label="HTML 查看方式"
            className="flex shrink-0 items-center rounded border border-border"
          >
            {(["code", "preview"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-label={mode === "code" ? "查看 HTML 代码" : "预览 HTML"}
                aria-pressed={htmlMode === mode}
                onClick={() => setHtmlMode(mode)}
                className={`rounded px-1.5 py-0.5 ${htmlMode === mode ? "bg-accent text-foreground" : "text-muted-foreground"}`}
              >
                {mode === "code" ? "代码" : "预览"}
              </button>
            ))}
          </div>
        )}
        {stat && <span className="shrink-0">{formatBytes(stat.size)}</span>}
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-label="重新读取文件" onClick={onRefresh} className="rounded p-1 hover:bg-accent">
              <RefreshCw className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">重新读取文件</TooltipContent>
        </Tooltip>
      </div>
      {stale && (
        <div
          className="flex shrink-0 items-center gap-2 border-amber-200 border-b bg-amber-50 px-3 py-1.5 text-amber-700 text-xs dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
          role="status"
        >
          <AlertTriangle className="size-3.5" />
          <span className="flex-1">磁盘内容已变化，当前显示的是上次读取的版本。</span>
          <button
            type="button"
            onClick={onRefresh}
            className="rounded px-2 py-0.5 hover:bg-amber-100 dark:hover:bg-amber-900"
          >
            重新加载
          </button>
        </div>
      )}
      {boundedText && status === "ready" && (
        <div
          className="shrink-0 border-neutral-200 border-b bg-muted/40 px-3 py-1.5 text-muted-foreground text-xs dark:border-neutral-700"
          data-region="bounded-preview"
          role="status"
        >
          {truncated
            ? "文档超过 256 KiB，当前以纯文本显示已读取的分段。"
            : "大文档已读取完毕，继续使用纯文本，避免整篇渲染阻塞。"}
        </div>
      )}
      {status === "loading" ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-neutral-400 text-sm">
          <Loader2 className="size-4 animate-spin" /> 读取文件…
        </div>
      ) : status === "deleted" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-neutral-500 text-sm">
          <FileQuestion className="size-8 text-neutral-300" />
          <p>文件已被删除或移动，历史更改记录仍保留。</p>
          <button
            type="button"
            onClick={onRefresh}
            className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-accent dark:border-neutral-600"
          >
            重试
          </button>
        </div>
      ) : status === "error" ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-red-600 text-sm dark:text-red-400"
          role="alert"
        >
          <AlertTriangle className="size-7" />
          <p className="max-w-md break-words">{error}</p>
          <button
            type="button"
            onClick={onRefresh}
            className="rounded-md border border-red-300 px-3 py-1 text-xs hover:bg-red-50 dark:hover:bg-red-950"
          >
            重试
          </button>
        </div>
      ) : status === "binary" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-neutral-500 text-sm">
          <FileQuestion className="size-8 text-neutral-300" />
          <p>此格式暂不支持安全内嵌预览。</p>
          <p className="text-neutral-400 text-xs">
            文件未被修改；文本、Markdown、代码、JSON、CSV、图片和 PDF 可直接预览。
          </p>
        </div>
      ) : extension === "pdf" ? (
        <iframe title={tab.title} src={mediaUrl} className="min-h-0 flex-1 border-0" />
      ) : mediaUrl ? (
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-neutral-100 p-4 dark:bg-neutral-900">
          <img src={mediaUrl} alt={tab.title} className="max-h-full max-w-full object-contain" />
        </div>
      ) : MARKDOWN_EXTENSIONS.has(extension) && richPreviewAllowed ? (
        <WorkspaceMarkdown content={content} scope={tab.scope} sourcePath={tab.path} rootResolved={tab.rootResolved} />
      ) : extension === "csv" || extension === "tsv" ? (
        <CsvPreview content={content} allowPartial={truncated} />
      ) : isHtml && richPreviewAllowed && htmlMode === "preview" ? (
        <SafeHtmlPreview content={content} title={tab.title} allowScripts />
      ) : CODE_EXTENSIONS.has(extension) && content.length <= 128 * 1024 ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <CodeBlockCode
            code={renderedText}
            language={CODE_LANGUAGES[extension] ?? "plaintext"}
            theme={isDarkMode ? "github-dark" : "github-light"}
            className="workspace-code-preview"
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <pre className="min-w-max whitespace-pre-wrap p-4 font-mono text-foreground text-xs leading-relaxed">
            {renderedText}
          </pre>
        </div>
      )}
      {truncated && status === "ready" && (
        <div className="shrink-0 border-neutral-200 border-t bg-background px-4 py-2 dark:border-neutral-700">
          <button
            type="button"
            onClick={() => void loadMore()}
            className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-accent dark:border-neutral-600"
          >
            加载下一段（每段 256 KiB）
          </button>
        </div>
      )}
      {error && status === "ready" && (
        <div
          className="border-red-200 border-t px-3 py-1 text-red-600 text-xs dark:border-red-800 dark:text-red-400"
          role="alert"
        >
          {error}
        </div>
      )}
    </section>
  );
}
