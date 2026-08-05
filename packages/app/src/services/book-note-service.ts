import type { BookNote, BookNoteSource } from "@/types/book";
import { invoke } from "@tauri-apps/api/core";

// BookNote 创建数据类型
export interface BookNoteCreateData {
  bookId: string;
  type: "bookmark" | "annotation" | "excerpt";
  cfi: string;
  text?: string;
  style?: "highlight" | "underline" | "squiggly";
  color?: "red" | "yellow" | "green" | "blue" | "violet";
  note: string;
  context?: {
    before: string;
    after: string;
  };
  /** AI 重点标注类别（仅 source="ai" 时落库；人工路径不传） */
  category?: string;
  /** 标注来源；缺省按 "user" 处理（人工路径不传，行为不变） */
  source?: BookNoteSource;
}

// BookNote 更新数据类型
export interface BookNoteUpdateData {
  type?: "bookmark" | "annotation" | "excerpt";
  cfi?: string;
  text?: string;
  style?: "highlight" | "underline" | "squiggly";
  color?: "red" | "yellow" | "green" | "blue" | "violet";
  note?: string;
  context?: {
    before: string;
    after: string;
  };
  /** AI 重点标注类别（COALESCE 语义：不传保留原值） */
  category?: string;
  /** 标注来源（COALESCE 语义：不传保留原值） */
  source?: BookNoteSource;
  /** 星标（COALESCE 语义：不传保留原值） */
  starred?: boolean;
}

/**
 * 创建新的书籍笔记
 */
export async function createBookNote(noteData: BookNoteCreateData): Promise<BookNote> {
  const result = await invoke<BookNote>("create_book_note", { noteData });
  return result;
}

/**
 * 获取指定书籍的所有笔记
 */
export async function getBookNotes(bookId: string): Promise<BookNote[]> {
  const result = await invoke<BookNote[]>("get_book_notes", { bookId });
  return result;
}

/** 跨书标注条目：book_notes 全字段 + 所属书 id/书名/作者（书已删为 null） */
export type BookNoteWithBook = BookNote & { bookId: string; bookTitle: string | null; bookAuthor: string | null };

/**
 * 跨书查询标注（notes 概念清除后 Agent 工具的数据源）：默认按创建时间倒序；
 * noteType 过滤（annotation/excerpt/bookmark），limit 缺省 200
 */
export async function getAllBookNotes(options?: { noteType?: string; limit?: number }): Promise<BookNoteWithBook[]> {
  const result = await invoke<BookNoteWithBook[]>("get_all_book_notes", {
    noteType: options?.noteType ?? null,
    limit: options?.limit ?? null,
  });
  return result;
}

/**
 * 更新指定的书籍笔记
 */
export async function updateBookNote(id: string, updateData: BookNoteUpdateData): Promise<BookNote> {
  const result = await invoke<BookNote>("update_book_note", { id, updateData });
  return result;
}

/**
 * 删除指定的书籍笔记
 */
export async function deleteBookNote(id: string): Promise<void> {
  await invoke("delete_book_note", { id });
}

/**
 * 清空指定书籍的 C2 AI 重点标注（"重新生成"前置步骤）。
 * 删除条件在 Rust 侧显式带 source='ai' AND category IS NOT NULL：
 * 仅清 C2 重点标注（恒带 category），对话创建的无 category AI 标注与人工标注均不受影响。返回删除条数。
 */
export async function deleteAiBookNotes(bookId: string): Promise<number> {
  const result = await invoke<number>("delete_ai_book_notes", { bookId });
  return result;
}
