import type { Note } from "@/types/note";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import dayjs from "dayjs";
import { toast } from "sonner";
import { toSafeAnnotationFileName } from "./export-annotations-markdown";

/** frontmatter 字符串值转义（双引号包围，内层引号/反斜杠转义） */
const yamlStr = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * 单篇笔记 → Markdown 文档（YAML frontmatter + 正文，pandoc 可直接消费）。
 * frontmatter 字段：title/book_title/location_tag/starred/created_at/updated_at
 */
export function buildNoteMarkdown(note: Note, bookTitle: string): string {
  const lines = [
    "---",
    `title: ${yamlStr(note.title)}`,
    `book_title: ${yamlStr(bookTitle)}`,
    `location_tag: ${note.locationTag ? yamlStr(note.locationTag) : '""'}`,
    `starred: ${note.starred}`,
    `created_at: ${yamlStr(dayjs(note.createdAt).format("YYYY-MM-DD HH:mm:ss"))}`,
    `updated_at: ${yamlStr(dayjs(note.updatedAt).format("YYYY-MM-DD HH:mm:ss"))}`,
    "---",
    "",
    note.content.trimEnd(),
    "",
  ];
  return lines.join("\n");
}

/** 笔记文件名：标题（清洗）或"无标题笔记"，带 id 前 8 位防同名覆盖 */
const noteFileName = (note: Note) => `${toSafeAnnotationFileName(note.title, "无标题笔记")}-${note.id.slice(0, 8)}.md`;

/** 单篇导出：保存对话框 → 写文件 */
export async function exportNoteToMarkdown(note: Note, bookTitle: string): Promise<boolean> {
  try {
    const path = await save({
      defaultPath: noteFileName(note),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return false; // 用户取消
    await writeTextFile(path, buildNoteMarkdown(note, bookTitle));
    toast.success("笔记已导出");
    return true;
  } catch (error) {
    console.error("导出笔记失败:", error);
    toast.error("导出笔记失败");
    return false;
  }
}

/** 批量导出：选目录 → 逐篇各存一个 .md（不合并——没有合集需求），返回成功篇数 */
export async function exportNotesToMarkdownFiles(notes: Note[], bookTitle: string): Promise<number> {
  try {
    if (notes.length === 0) {
      toast.error("没有可导出的笔记");
      return 0;
    }
    const dir = await open({ directory: true, title: "选择笔记导出目录" });
    if (!dir) return 0; // 用户取消
    let succeeded = 0;
    for (const note of notes) {
      try {
        await writeTextFile(`${dir}/${noteFileName(note)}`, buildNoteMarkdown(note, bookTitle));
        succeeded += 1;
      } catch (error) {
        console.error(`导出笔记《${note.title || note.id}》失败:`, error);
      }
    }
    if (succeeded === notes.length) {
      toast.success(`已导出 ${succeeded} 篇笔记`);
    } else {
      toast.warning(`导出完成：成功 ${succeeded}/${notes.length} 篇`);
    }
    return succeeded;
  } catch (error) {
    console.error("批量导出笔记失败:", error);
    toast.error("批量导出笔记失败");
    return 0;
  }
}
