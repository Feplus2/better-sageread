import type { BookNote, HighlightColor } from "@/types/book";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import dayjs from "dayjs";
import { toast } from "sonner";

/** 标注导出元信息：title = 论文/书籍标题（文档头与文件名共用），successText 可定制成功提示 */
export interface AnnotationExportMeta {
  title: string;
  successText?: string;
}

/** 高亮色中文名（Markdown 色标用文字） */
export const HIGHLIGHT_COLOR_LABELS: Record<HighlightColor, string> = {
  red: "红色",
  yellow: "黄色",
  green: "绿色",
  blue: "蓝色",
  violet: "紫色",
};

export function colorLabel(color?: HighlightColor): string {
  return color ? HIGHLIGHT_COLOR_LABELS[color] : HIGHLIGHT_COLOR_LABELS.yellow;
}

/** 文件名清洗：去掉文件系统非法字符 */
export function toSafeAnnotationFileName(name: string, fallback = "未命名文档"): string {
  return name.replace(/[<>:"/\\|?*]/g, "").trim() || fallback;
}

/** 展示用文本折叠（Markdown 原文含换行/缩进） */
export const collapseAnnotationWs = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * 将单条标注渲染为 Markdown 片段：
 * - 【黄色】★ 原文引用（星标带 ★）；评论（有则附，> 引用块）；前后文（有则附）
 */
export function renderAnnotationMarkdown(annotation: BookNote): string {
  const star = annotation.starred ? "★ " : "";
  const lines = [`- 【${colorLabel(annotation.color)}】${star}${collapseAnnotationWs(annotation.text ?? "")}`];

  const note = annotation.note?.trim();
  if (note) {
    for (const line of note.split("\n")) {
      lines.push(`  > ${line}`.trimEnd());
    }
  }

  if (annotation.context) {
    lines.push(
      `  上下文：…${collapseAnnotationWs(annotation.context.before)} / ${collapseAnnotationWs(annotation.context.after)}…`,
    );
  }

  return lines.join("\n");
}

/**
 * 将一组标注构建为 Markdown 文档（含元信息头）
 */
export function buildAnnotationsMarkdown(annotations: BookNote[], meta: { title: string }): string {
  const lines: string[] = [];

  lines.push(`# 《${meta.title || "未命名文档"}》标注`);
  lines.push("");
  lines.push(`- 导出时间：${dayjs().format("YYYY-MM-DD HH:mm:ss")}`);
  lines.push(`- 标注数：${annotations.length}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## 标注列表");
  lines.push("");

  for (const annotation of annotations) {
    lines.push(renderAnnotationMarkdown(annotation));
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * 弹出保存对话框并将一组标注导出为 Markdown 文件
 */
export async function exportAnnotationsToMarkdown(
  annotations: BookNote[],
  meta: AnnotationExportMeta,
): Promise<boolean> {
  try {
    if (annotations.length === 0) {
      toast.error("没有可导出的内容");
      return false;
    }

    const markdown = buildAnnotationsMarkdown(annotations, meta);

    const path = await save({
      defaultPath: `${toSafeAnnotationFileName(meta.title)}-标注.md`,
      filters: [
        {
          name: "Markdown",
          extensions: ["md"],
        },
      ],
    });

    // 用户取消保存，不视为失败
    if (!path) {
      return false;
    }

    await writeTextFile(path, markdown);
    toast.success(meta.successText ?? "标注导出成功");
    return true;
  } catch (error) {
    console.error("导出标注失败:", error);
    toast.error("导出标注失败");
    return false;
  }
}
