import { updateBook } from "@/services/book-service";
/**
 * 全局助手工具：标签管理
 */
import { createTag, getTags, updateTag } from "@/services/tag-service";
import type { SimpleBook } from "@/types/simple-book";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";

export const manageTagsTool = tool({
  description: `管理书籍标签：查看、创建、重命名、分配、移除。

🎯 **核心功能**：
• list：查看所有标签
• create：创建新标签
• rename：重命名已有标签
• assign：给书籍分配标签
• remove：移除书籍上的标签

📊 **返回内容**：
操作结果`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    action: z.enum(["list", "create", "rename", "assign", "remove"]).describe("操作类型"),
    tagName: z.string().optional().describe("标签名称（create/assign/remove 时需要；rename 时为当前名称）"),
    newTagName: z.string().optional().describe("新标签名称（rename 时需要）"),
    bookId: z.string().optional().describe("书籍 ID（assign/remove 时需要）"),
  }),

  execute: async ({
    reasoning,
    action,
    tagName,
    newTagName,
    bookId,
  }: {
    reasoning: string;
    action: "list" | "create" | "rename" | "assign" | "remove";
    tagName?: string;
    newTagName?: string;
    bookId?: string;
  }) => {
    try {
      // ==================== 列出所有标签 ====================
      if (action === "list") {
        const tags = await getTags();
        return {
          results: {
            success: true,
            message: `共有 ${tags.length} 个标签`,
            tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
          },
          meta: { reasoning },
        };
      }

      // ==================== 创建标签 ====================
      if (action === "create") {
        if (!tagName?.trim()) {
          return {
            results: { success: false, message: "创建标签需要提供 tagName 参数" },
            meta: { reasoning },
          };
        }

        const tag = await createTag({ name: tagName.trim() });
        return {
          results: {
            success: true,
            message: `标签「${tag.name}」创建成功`,
            createdTag: { id: tag.id, name: tag.name },
          },
          meta: { reasoning, tagName },
        };
      }

      // ==================== 重命名标签 ====================
      if (action === "rename") {
        if (!tagName?.trim() || !newTagName?.trim()) {
          return {
            results: { success: false, message: "重命名标签需要同时提供 tagName（当前名称）和 newTagName（新名称）" },
            meta: { reasoning },
          };
        }

        const allTagsForRename = await getTags();
        const existingTag = allTagsForRename.find((t) => t.name === tagName.trim());
        if (!existingTag) {
          return {
            results: {
              success: false,
              message: `标签「${tagName}」不存在`,
              availableTags: allTagsForRename.map((t) => t.name),
            },
            meta: { reasoning, tagName },
          };
        }

        const updated = await updateTag(existingTag.id, { name: newTagName.trim() });
        return {
          results: {
            success: true,
            message: `标签「${tagName}」已重命名为「${updated.name}」`,
            renamedTag: { id: updated.id, name: updated.name },
          },
          meta: { reasoning, tagName, newTagName },
        };
      }

      // ==================== 分配/移除标签 ====================
      if (action === "assign" || action === "remove") {
        if (!tagName?.trim() || !bookId) {
          return {
            results: {
              success: false,
              message: `${action === "assign" ? "分配" : "移除"}标签需要同时提供 tagName 和 bookId 参数`,
            },
            meta: { reasoning },
          };
        }

        // 查找标签
        const allTags = await getTags();
        const tag = allTags.find((t) => t.name === tagName.trim());
        if (!tag) {
          return {
            results: {
              success: false,
              message: `标签「${tagName}」不存在，请先创建`,
              availableTags: allTags.map((t) => t.name),
            },
            meta: { reasoning, tagName },
          };
        }

        // 获取书籍当前标签
        const book = await invoke<SimpleBook | null>("get_book_by_id", { id: bookId });
        if (!book) {
          return {
            results: { success: false, message: `未找到 ID 为 "${bookId}" 的书籍` },
            meta: { reasoning, bookId },
          };
        }

        const currentTags: string[] = book.tags ?? [];

        if (action === "assign") {
          if (currentTags.includes(tag.id)) {
            return {
              results: {
                success: true,
                message: `《${book.title}》已有标签「${tag.name}」，无需重复分配`,
              },
              meta: { reasoning, tagName, bookId },
            };
          }
          await updateBook(bookId, { tags: [...currentTags, tag.id] });
          return {
            results: {
              success: true,
              message: `已为《${book.title}》分配标签「${tag.name}」`,
            },
            meta: { reasoning, tagName, bookId },
          };
        }

        // remove
        if (!currentTags.includes(tag.id)) {
          return {
            results: {
              success: true,
              message: `《${book.title}》没有标签「${tag.name}」，无需移除`,
            },
            meta: { reasoning, tagName, bookId },
          };
        }
        await updateBook(bookId, { tags: currentTags.filter((id) => id !== tag.id) });
        return {
          results: {
            success: true,
            message: `已移除《${book.title}」的标签「${tag.name}」`,
          },
          meta: { reasoning, tagName, bookId },
        };
      }

      return {
        results: { success: false, message: `未知操作: ${action}` },
        meta: { reasoning },
      };
    } catch (error) {
      throw new Error(`标签操作失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  },
});
