import type React from "react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { getTrashedBooks, uploadBook } from "@/services/book-service";
import { FILE_ACCEPT_FORMATS } from "@/services/constants";
import { syncGetConfig, syncUploadBook } from "@/services/sync-service";
import { useLibraryStore } from "@/store/library-store";
import type { SimpleBook } from "@/types/simple-book";
import { getFilename, listFormater } from "@/utils/book";
import { readFile } from "@tauri-apps/plugin-fs";

export function useBookUpload() {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const { refreshBooks } = useLibraryStore();

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    handleDropedFiles(files);
  }, []);

  const handleDropedFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;

    const supportedFiles = files.filter((file) => {
      const fileExt = file.name.split(".").pop()?.toLowerCase();
      return FILE_ACCEPT_FORMATS.includes(`.${fileExt}`);
    });

    if (supportedFiles.length === 0) {
      toast.error(`未找到支持的文件。支持的格式：${FILE_ACCEPT_FORMATS}`);
      return;
    }

    await importBooks(supportedFiles);
  }, []);

  const importBooks = useCallback(
    async (files: File[]) => {
      setIsUploading(true);
      const failedFiles: string[] = [];
      const successBooks: SimpleBook[] = [];

      for (const file of files) {
        try {
          const newBook = await uploadBook(file);
          successBooks.push(newBook);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          // 重复导入区分在库/在回收站（此前一律静默计入失败列表，用户不知去向——2026-08-13 实证）
          const dup = msg.match(/已存在:\s*(.+?)\s*\(ID:\s*([0-9a-f]+)\)/);
          if (dup) {
            const [, title, id] = dup;
            const inTrash = await getTrashedBooks()
              .then((list) => list.some((b) => b.id === id))
              .catch(() => false);
            toast.info(
              inTrash
                ? `《${title}》已在回收站中，可在「回收站」恢复，无需重复导入`
                : `《${title}》已在书库中，无需重复导入`,
            );
            continue;
          }
          const baseFilename = getFilename(file.name);
          failedFiles.push(baseFilename);
        }
      }

      setIsUploading(false);

      if (failedFiles.length > 0) {
        toast.error(`导入书籍失败：${listFormater(false).format(failedFiles)}`);
      }

      if (successBooks.length > 0) {
        toast.success(`成功导入 ${successBooks.length} 本书籍`);
        await refreshBooks();

        // L2 开启时异步上传书籍文件到云端（不阻塞导入流程）
        syncGetConfig()
          .then((config) => {
            if (config?.l2_enabled) {
              for (const book of successBooks) {
                syncUploadBook(book.id).catch((e) => console.warn("书籍文件自动上传失败（忽略）:", book.title, e));
              }
            }
          })
          .catch(() => {});
      }
    },
    [refreshBooks],
  );

  const selectFiles = useCallback((): Promise<FileList | null> => {
    return new Promise((resolve) => {
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = FILE_ACCEPT_FORMATS;
      fileInput.multiple = true;
      fileInput.click();

      fileInput.onchange = () => {
        resolve(fileInput.files);
      };
    });
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      handleDropedFiles(files);
    },
    [handleDropedFiles],
  );

  const triggerFileSelect = useCallback(async () => {
    const files = await selectFiles();
    if (files) {
      handleDropedFiles(Array.from(files));
    }
  }, [selectFiles, handleDropedFiles]);

  /** 按磁盘路径导入书籍（Tauri 原生拖放只给路径不给 File 对象；
   *  复用 importBooks 的重复检测/失败汇总/云端上传链路） */
  const importBookPaths = useCallback(
    async (paths: string[]) => {
      const files: File[] = [];
      for (const p of paths) {
        try {
          const bytes = await readFile(p);
          files.push(new File([bytes.buffer as ArrayBuffer], p.split(/[\\/]/).pop() ?? p));
        } catch (error) {
          console.warn("读取拖入文件失败:", p, error);
        }
      }
      if (files.length > 0) {
        await importBooks(files);
      }
    },
    [importBooks],
  );

  return {
    isDragOver,
    isUploading,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleFileSelect,
    handleDropedFiles,
    triggerFileSelect,
    importBookPaths,
  };
}
