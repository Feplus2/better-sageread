import type { Thread } from "@/types/thread";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { UIMessage } from "ai";
import dayjs from "dayjs";
import { marked } from "marked";
import { toast } from "sonner";
import { EXPORT_HTML_CSS, sanitizeHtml } from "./export-html-shared";
import { type ExportMeta, resolveBookTitle, toSafeFileName } from "./export-thread-markdown";

// 共享件再导出：export-thread-image 等既有消费方不动
export { EXPORT_HTML_CSS, sanitizeHtml } from "./export-html-shared";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 导出文档头（标题 + 元信息行），HTML 导出与图片导出共用
 */
export function buildExportHeaderHtml(meta: { title: string; bookTitle?: string; messageCount: number }): string {
  return `<header>
    <h1>${escapeHtml(meta.title || "未命名对话")}</h1>
    <div class="meta">
      ${meta.bookTitle ? `<span>书名：《${escapeHtml(meta.bookTitle)}》</span>` : ""}
      <span>导出时间：${dayjs().format("YYYY-MM-DD HH:mm:ss")}</span>
      <span>消息数：${meta.messageCount}</span>
    </div>
  </header>`;
}

/**
 * 将单条消息的 parts 渲染为 HTML 片段（text → marked，quote → blockquote）
 */
export function renderMessageHtml(message: UIMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  let html = "";
  let textBuffer = "";

  const flushText = () => {
    const text = textBuffer.trim();
    if (text) {
      html += sanitizeHtml(marked.parse(text, { async: false }));
    }
    textBuffer = "";
  };

  for (const part of parts as any[]) {
    if (part?.type === "text") {
      textBuffer += part.text ?? "";
      continue;
    }

    if (part?.type === "quote") {
      flushText();
      const quote = escapeHtml(String(part.text ?? "")).replace(/\n/g, "<br>");
      if (quote.trim()) {
        html += `<blockquote>${quote}</blockquote>`;
      }
    }
  }

  flushText();
  return html;
}

/**
 * 将一组消息渲染为消息流 HTML（用户/AI 气泡分区）
 */
export function buildMessagesHtml(messages: UIMessage[]): string {
  return messages
    .map((message) => {
      const body = renderMessageHtml(message);
      if (!body) return "";
      const isUser = message.role === "user";
      return `<div class="message ${isUser ? "user" : "assistant"}">
  <div class="role">${isUser ? "用户" : "AI"}</div>
  <div class="bubble">${body}</div>
</div>`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * 将一组消息构建为自包含单文件 HTML 文档（样式全内联，无外部依赖）
 */
export function buildThreadHtml(messages: UIMessage[], meta: { title: string; bookTitle?: string }): string {
  const title = meta.title || "未命名对话";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${EXPORT_HTML_CSS}</style>
</head>
<body>
<div class="container">
  ${buildExportHeaderHtml({ title, bookTitle: meta.bookTitle, messageCount: messages.length })}
  <main>
${buildMessagesHtml(messages)}
  </main>
  <footer>由 Better SageRead 导出</footer>
</div>
</body>
</html>
`;
}

/**
 * 弹出保存对话框并将一组消息导出为自包含 HTML 文件
 */
export async function exportMessagesToHtml(messages: UIMessage[], meta: ExportMeta): Promise<boolean> {
  try {
    const exportable = messages.filter((m) => renderMessageHtml(m));
    if (exportable.length === 0) {
      toast.error("没有可导出的内容");
      return false;
    }

    const bookTitle = await resolveBookTitle(meta.bookId);
    const html = buildThreadHtml(exportable, { title: meta.title, bookTitle });

    const path = await save({
      defaultPath: `${toSafeFileName(meta.title)}.html`,
      filters: [
        {
          name: "HTML",
          extensions: ["html"],
        },
      ],
    });

    // 用户取消保存，不视为失败
    if (!path) {
      return false;
    }

    await writeTextFile(path, html);
    toast.success(meta.successText ?? "对话导出成功");
    return true;
  } catch (error) {
    console.error("导出对话失败:", error);
    toast.error("导出对话失败");
    return false;
  }
}

/**
 * 导出整个对话为自包含 HTML 文件
 */
export async function exportThreadToHtml(thread: Thread): Promise<boolean> {
  return exportMessagesToHtml(thread.messages, {
    title: thread.title || "未命名对话",
    bookId: thread.book_id,
  });
}
