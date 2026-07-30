import { HIGHLIGHT_COLOR_HEX } from "@/services/constants";
import type { BookNote } from "@/types/book";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import dayjs from "dayjs";
import { toast } from "sonner";
import {
  type AnnotationExportMeta,
  collapseAnnotationWs,
  colorLabel,
  toSafeAnnotationFileName,
} from "./export-annotations-markdown";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 标注导出文档的共享样式（HTML / 图片 / PDF 打印页共用，单一事实源）。
 * 配色与对话导出同风格（暖纸底色 + 中性文字，明暗环境下都可读）。
 */
export const EXPORT_ANNOTATIONS_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 16px; background: #f5f1e8; color: #3a3226;
         font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.7; }
  .container { max-width: 760px; margin: 0 auto; }
  header { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #ddd3b8; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  .meta { font-size: 13px; color: #8a7c60; }
  .meta span + span::before { content: " · "; }
  .annotation { margin-bottom: 14px; padding: 12px 16px; background: #fffdf7; border: 1px solid #e5dcc4;
                border-radius: 12px; box-shadow: 0 1px 3px rgba(60, 50, 30, 0.08); }
  .annotation-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
                     font-size: 12px; color: #8a7c60; }
  .dot { width: 10px; height: 10px; border-radius: 9999px; flex-shrink: 0; }
  .star { color: #b45309; }
  .quote { font-size: 15px; font-weight: 500; }
  .note { margin-top: 8px; padding: 4px 12px; border-left: 3px solid #a05a2c;
          background: rgba(160, 90, 44, 0.07); color: #6b5c42; border-radius: 0 6px 6px 0; font-size: 14px; }
  .context { margin-top: 6px; font-size: 13px; color: #8a7c60; }
  footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid #ddd3b8;
           font-size: 12px; color: #8a7c60; text-align: center; }
`;

/**
 * 导出文档头（标题 + 元信息行），HTML / 图片 / PDF 打印页共用
 */
export function buildAnnotationsHeaderHtml(meta: { title: string; count: number }): string {
  return `<header>
    <h1>《${escapeHtml(meta.title || "未命名文档")}》标注</h1>
    <div class="meta">
      <span>导出时间：${dayjs().format("YYYY-MM-DD HH:mm:ss")}</span>
      <span>标注数：${meta.count}</span>
    </div>
  </header>`;
}

/**
 * 单条标注 → HTML 卡片：色点 + 颜色名 + ★ 星标（有则）+ quote 原文 + 评论（有则）+ 前后文（有则）
 */
export function renderAnnotationHtml(annotation: BookNote): string {
  const color = annotation.color ? HIGHLIGHT_COLOR_HEX[annotation.color] : HIGHLIGHT_COLOR_HEX.yellow;
  const star = annotation.starred ? `<span class="star">★ 星标</span>` : "";
  const quote = escapeHtml(collapseAnnotationWs(annotation.text ?? ""));
  const note = annotation.note?.trim();
  const noteHtml = note ? `<div class="note">${escapeHtml(note).replace(/\n/g, "<br>")}</div>` : "";
  const contextHtml = annotation.context
    ? `<div class="context">…${escapeHtml(collapseAnnotationWs(annotation.context.before))} / ${escapeHtml(
        collapseAnnotationWs(annotation.context.after),
      )}…</div>`
    : "";

  return `<div class="annotation">
  <div class="annotation-head"><span class="dot" style="background:${color}"></span><span>${colorLabel(
    annotation.color,
  )}</span>${star}</div>
  <div class="quote">${quote}</div>
  ${noteHtml}
  ${contextHtml}
</div>`;
}

/**
 * 标注列表 HTML（图片导出复用）
 */
export function buildAnnotationsListHtml(annotations: BookNote[]): string {
  return annotations.map(renderAnnotationHtml).join("\n");
}

/**
 * 将一组标注构建为自包含单文件 HTML 文档（样式全内联，无外部依赖）。
 * autoPrint 供 PDF 打印页使用：加载完成自动唤起浏览器打印（另存为 PDF）。
 */
export function buildAnnotationsHtml(
  annotations: BookNote[],
  meta: { title: string },
  options?: { autoPrint?: boolean },
): string {
  const title = `《${meta.title || "未命名文档"}》标注`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${EXPORT_ANNOTATIONS_CSS}</style>
</head>
<body>
<div class="container">
  ${buildAnnotationsHeaderHtml({ title: meta.title, count: annotations.length })}
  <main>
${buildAnnotationsListHtml(annotations)}
  </main>
  <footer>由 SageRead 导出</footer>
</div>
${options?.autoPrint ? "<script>window.addEventListener('load', () => window.print());</script>" : ""}
</body>
</html>
`;
}

/**
 * 弹出保存对话框并将一组标注导出为自包含 HTML 文件
 */
export async function exportAnnotationsToHtml(annotations: BookNote[], meta: AnnotationExportMeta): Promise<boolean> {
  try {
    if (annotations.length === 0) {
      toast.error("没有可导出的内容");
      return false;
    }

    const html = buildAnnotationsHtml(annotations, meta);

    const path = await save({
      defaultPath: `${toSafeAnnotationFileName(meta.title)}-标注.html`,
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
    toast.success(meta.successText ?? "标注导出成功");
    return true;
  } catch (error) {
    console.error("导出标注失败:", error);
    toast.error("导出标注失败");
    return false;
  }
}
