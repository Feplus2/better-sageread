"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { exportCodeBlock } from "@/lib/export-code-block";
import { detectPreviewFormat, getPreviewTitle, isPreviewable } from "@/lib/preview-utils";
import { cn } from "@/lib/utils";
import { usePreviewStore } from "@/store/preview-store";
import { Check, Copy, Download, Eye } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { codeToHtml } from "shiki";

export type CodeBlockProps = {
  children?: React.ReactNode;
  className?: string;
  code?: string;
  language?: string;
} & React.HTMLProps<HTMLDivElement>;

function CodeBlock({ children, className, code, language = "plaintext", ...props }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const previewable = code ? isPreviewable(language, code) : false;

  const handleCopy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("复制失败:", error);
    }
  };

  const handlePreview = () => {
    if (!code) return;
    const format = detectPreviewFormat(language, code);
    if (!format) return;
    usePreviewStore.getState().openPreview({
      id: `preview-${Date.now()}`,
      content: code,
      language,
      format,
      title: getPreviewTitle(format),
    });
  };

  const handleExport = () => {
    if (!code) return;
    void exportCodeBlock(code, language);
  };

  return (
    <div
      className={cn(
        "not-prose flex w-full flex-col overflow-clip border",
        "rounded-xl border-border bg-card text-card-foreground",
        className,
      )}
      {...props}
    >
      <div className="flex items-center justify-between border-border border-b px-3 py-1.5">
        <span className="font-mono text-muted-foreground text-xs">{language}</span>
        <div className="flex items-center gap-0.5">
          {previewable && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handlePreview}
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Eye className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">预览</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleExport}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Download className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">导出</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleCopy}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {copied ? <Check className="size-3.5 text-green-500" /> : <Copy className="size-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">复制</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {children}
    </div>
  );
}

export type CodeBlockCodeProps = {
  code: string;
  language?: string;
  theme?: string;
  className?: string;
} & React.HTMLProps<HTMLDivElement>;

function CodeBlockCode({ code, language = "tsx", theme = "github-dark", className, ...props }: CodeBlockCodeProps) {
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

  useEffect(() => {
    async function highlight() {
      if (!code) {
        setHighlightedHtml("<pre><code></code></pre>");
        return;
      }

      const html = await codeToHtml(code, { lang: language, theme });
      setHighlightedHtml(html);
    }
    highlight();
  }, [code, language, theme]);

  const classNames = cn("w-full overflow-x-auto bg-[#0d1117] text-[13px] [&>pre]:px-4 [&>pre]:py-4", className);

  // SSR fallback: render plain code if not hydrated yet
  return highlightedHtml ? (
    <div className={classNames} dangerouslySetInnerHTML={{ __html: highlightedHtml }} {...props} />
  ) : (
    <div className={classNames} {...props}>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export type CodeBlockGroupProps = React.HTMLAttributes<HTMLDivElement>;

function CodeBlockGroup({ children, className, ...props }: CodeBlockGroupProps) {
  return (
    <div className={cn("flex items-center justify-between", className)} {...props}>
      {children}
    </div>
  );
}

export { CodeBlockGroup, CodeBlockCode, CodeBlock };
