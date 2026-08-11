/**
 * 共享工具：笔记面板管理（notes 表——长文 Markdown 笔记，与"划线标注"book_notes 是两套概念）。
 *
 * 工厂形态与 readBookSection 一致：阅读/论文助手绑定当前 bookId/paperId（模型无需传 bookId），
 * 全局助手无绑定（需先用 getBooks 按书名/论文名查找）。
 * 写入约定（铁边界）：create/update 落库前弹确认卡（tool-guard 统一包装，本工具不自行实现），
 * 模型应在调用前先把草稿展示给用户。
 */
import { exportNoteToMarkdown } from "@/lib/export-notes-markdown";
import { resolveBookTitle } from "@/lib/export-thread-markdown";
import { createNote, getNotes, updateNote } from "@/services/note-service";
import type { Note } from "@/types/note";
import { tool } from "ai";
import { z } from "zod";

/** 列表条目的轻量视图（不带正文，防刷屏） */
const toListItem = (note: Note) => ({
  id: note.id,
  title: note.title || "（无标题）",
  locationTag: note.locationTag,
  starred: note.starred,
  contentLength: note.content.length,
  updatedAt: note.updatedAt,
});

/** 按 id 或标题（先精确后包含，大小写不敏感）定位笔记 */
function findNote(notes: Note[], noteId?: string, title?: string): Note | undefined {
  if (noteId) return notes.find((n) => n.id === noteId);
  if (title?.trim()) {
    const needle = title.trim().toLowerCase();
    return (
      notes.find((n) => n.title.trim().toLowerCase() === needle) ??
      notes.find((n) => n.title.trim().toLowerCase().includes(needle))
    );
  }
  return undefined;
}

export const createManageNotesTool = (boundBookId?: string) =>
  tool({
    description: `管理某本书/某篇论文的笔记（笔记面板里的长文 Markdown 笔记——总结/灵感/人话版解读的落点；不是划线标注，查划线请用 notes 工具）。

🎯 **动作**：
• list：列出全部笔记（id/标题/位置标签/星标/正文长度/更新时间，不含正文）
• read：读取单篇笔记完整内容（noteId 或 title 定位）
• create：新建笔记（title 可空，content 为 Markdown，locationTag 可空）
• update：修改笔记（mode=replace 全文替换 | append 追加；可同时改 title/locationTag）
• toggleStar：星标切换
• export：导出单篇笔记为 Markdown 文件（YAML frontmatter 含书名/位置标签，pandoc 可消费）

📋 **前提**：bookId——阅读/论文场景已自动绑定当前书/论文；全局场景先用 getBooks 按书名查找。

🖊 **写入约定**：create/update 会向用户弹确认卡（草稿内容可见），调用前请先把要写的内容以草稿形式展示给用户讨论确认；不要为琐碎改动频繁调用。`,

    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因"),
      action: z.enum(["list", "read", "create", "update", "toggleStar", "export"]).describe("操作类型"),
      bookId: z.string().optional().describe("书籍/论文 ID（全局场景必传；阅读/论文场景已绑定，省略）"),
      noteId: z.string().optional().describe("笔记 ID（read/update/toggleStar/export 时与 title 二选一）"),
      title: z
        .string()
        .optional()
        .describe("笔记标题（read/update/toggleStar/export 时按标题模糊定位；create/update 时为标题内容）"),
      content: z.string().optional().describe("Markdown 正文（create 必填；update 的 replace/append 内容）"),
      mode: z.enum(["replace", "append"]).optional().describe("update 的写入模式（缺省 append）"),
      locationTag: z.string().optional().describe("位置标签（create/update 时可指定；缺省不改动）"),
    }),

    execute: async ({ reasoning, action, bookId, noteId, title, content, mode, locationTag }) => {
      try {
        const effectiveBookId = boundBookId ?? bookId;
        if (!effectiveBookId && action !== "list") {
          return {
            results: { success: false, message: "需要 bookId 参数（先用 getBooks 按书名查找）" },
            meta: { reasoning },
          };
        }
        if (!effectiveBookId) {
          return {
            results: { success: false, message: "全局场景请先用 getBooks 按书名查找 bookId，再调用本工具" },
            meta: { reasoning },
          };
        }

        // ==================== list ====================
        if (action === "list") {
          const notes = await getNotes(effectiveBookId);
          return {
            results: {
              success: true,
              message: `共 ${notes.length} 篇笔记`,
              notes: notes.map(toListItem),
            },
            meta: { reasoning },
          };
        }

        // 其余动作需要定位具体笔记
        const notes = await getNotes(effectiveBookId);
        const target = findNote(notes, noteId, title);

        // ==================== create ====================
        if (action === "create") {
          if (!content?.trim()) {
            return {
              results: { success: false, message: "create 需要 content 参数（Markdown 正文）" },
              meta: { reasoning },
            };
          }
          const created = await createNote({
            bookId: effectiveBookId,
            title: title?.trim() ?? "",
            content: content.trim(),
            locationTag: locationTag?.trim() || null,
          });
          return {
            results: {
              success: true,
              message: `笔记已创建${created.title ? `《${created.title}》` : ""}（用户可在笔记面板查看/编辑）`,
              note: toListItem(created),
            },
            meta: { reasoning },
          };
        }

        if (!target) {
          return {
            results: {
              success: false,
              message: `未找到笔记${title ? `「${title}」` : noteId ? `（id: ${noteId}）` : ""}（list 可看全部笔记）`,
              available: notes.map((n) => n.title || "（无标题）"),
            },
            meta: { reasoning },
          };
        }

        // ==================== read ====================
        if (action === "read") {
          return {
            results: { success: true, note: { ...toListItem(target), content: target.content } },
            meta: { reasoning },
          };
        }

        // ==================== update ====================
        if (action === "update") {
          const writeMode = mode ?? "append";
          const nextContent =
            content === undefined
              ? undefined
              : writeMode === "replace"
                ? content.trim()
                : `${target.content.trimEnd()}\n\n${content.trim()}`;
          const updated = await updateNote(target.id, {
            title: title?.trim() ? title.trim() : undefined,
            content: nextContent,
            locationTag: locationTag?.trim() ? locationTag.trim() : undefined,
          });
          return {
            results: {
              success: true,
              message: `笔记已更新（${writeMode === "replace" ? "全文替换" : "追加"}模式）`,
              note: toListItem(updated),
            },
            meta: { reasoning },
          };
        }

        // ==================== toggleStar ====================
        if (action === "toggleStar") {
          const updated = await updateNote(target.id, { starred: !target.starred });
          return {
            results: { success: true, message: updated.starred ? "已加星标" : "已取消星标", note: toListItem(updated) },
            meta: { reasoning },
          };
        }

        // ==================== export ====================
        if (action === "export") {
          const bookTitle = (await resolveBookTitle(effectiveBookId)) || "未命名";
          const ok = await exportNoteToMarkdown(target, bookTitle);
          return {
            results: ok
              ? { success: true, message: `笔记《${target.title || "无标题"}》已导出` }
              : { success: false, message: "导出被取消或失败" },
            meta: { reasoning },
          };
        }

        return { results: { success: false, message: `未知操作: ${action}` }, meta: { reasoning } };
      } catch (error) {
        throw new Error(`笔记操作失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
