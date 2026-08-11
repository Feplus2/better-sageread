import type { Note, NoteCreateData, NoteUpdateData } from "@/types/note";
import { invoke } from "@tauri-apps/api/core";

/**
 * 笔记面板服务（notes 表）：CRUD 直通 Rust 命令。
 * 排序在 Rust 侧完成：星标置顶 → 阅读流（location_block，空值排后）→ 创建时间。
 */

export async function createNote(noteData: NoteCreateData): Promise<Note> {
  return await invoke<Note>("create_note", { noteData });
}

export async function getNotes(bookId: string): Promise<Note[]> {
  return await invoke<Note[]>("get_notes", { bookId });
}

export async function updateNote(id: string, updateData: NoteUpdateData): Promise<Note> {
  return await invoke<Note>("update_note", { id, updateData });
}

export async function deleteNote(id: string): Promise<void> {
  await invoke("delete_note", { id });
}
