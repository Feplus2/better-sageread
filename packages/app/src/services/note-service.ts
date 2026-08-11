import type { Note, NoteCreateData, NoteUpdateData } from "@/types/note";
import { invoke } from "@tauri-apps/api/core";

/**
 * 笔记面板服务（notes 表）：CRUD 直通 Rust 命令。
 * 排序在 Rust 侧完成：星标置顶 → 阅读流（location_block，空值排后）→ 创建时间。
 *
 * 变更广播：写操作成功后派发到 window（"sageread:notes-changed"，detail.bookId），
 * NotesTab 监听重拉——聊天区「存为笔记」与 manageNotes 工具的外部写入由此实时刷新列表。
 */

export const NOTES_CHANGED_EVENT = "sageread:notes-changed";

function emitNotesChanged(bookId: string): void {
  window.dispatchEvent(new CustomEvent(NOTES_CHANGED_EVENT, { detail: { bookId } }));
}

export async function createNote(noteData: NoteCreateData): Promise<Note> {
  const note = await invoke<Note>("create_note", { noteData });
  emitNotesChanged(note.bookId);
  return note;
}

export async function getNotes(bookId: string): Promise<Note[]> {
  return await invoke<Note[]>("get_notes", { bookId });
}

export async function updateNote(id: string, updateData: NoteUpdateData): Promise<Note> {
  const note = await invoke<Note>("update_note", { id, updateData });
  emitNotesChanged(note.bookId);
  return note;
}

export async function deleteNote(id: string): Promise<void> {
  await invoke("delete_note", { id });
  // delete 无返回行，bookId 由调用方持有——删除事件的刷新由调用方自行 setNotes/reload 处理
}
