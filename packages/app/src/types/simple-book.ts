export interface SimpleBook {
  id: string;
  title: string;
  author: string;
  format: BookFormat;
  filePath: string;
  coverPath?: string;

  fileSize: number;
  language: string;

  tags?: string[];

  /** 回收站软删除时间戳（毫秒），null/undefined = 未删除 */
  trashedAt?: number | null;

  createdAt: number;
  updatedAt: number;
}

export interface BookUploadData {
  id: string;
  title: string;
  author: string;
  format: BookFormat;
  fileSize: number;
  language: string;
  tempFilePath: string;
  coverTempFilePath?: string;
  metadata: any;
}

export interface BookQueryOptions {
  limit?: number;
  offset?: number;
  searchQuery?: string;
  tags?: string[];
  sortBy?: "title" | "author" | "createdAt" | "updatedAt";
  sortOrder?: "asc" | "desc";
}

export interface BookUpdateData {
  title?: string;
  author?: string;
  tags?: string[];
}

export interface BookStatus {
  bookId: string;
  status: "unread" | "reading" | "completed";
  progressCurrent: number;
  progressTotal: number;
  location: string;
  lastReadAt?: number;
  /** 真进度时间戳（位置最后一次真实变化的时间，同步合并用） */
  positionChangedAt?: number | null;
  /** 当前位置的累计活跃阅读秒数（位置变化时清零） */
  dwellSeconds?: number;
  startedAt?: number;
  completedAt?: number;
  /** 重要度打星（0-3，0=未打星） */
  rating?: number;
  metadata?: {
    vectorization?: BookVectorizationMeta;
    translation?: BookTranslationMeta;
    [k: string]: any;
  };
  createdAt: number;
  updatedAt: number;
}

export interface BookStatusUpdateData {
  status?: "unread" | "reading" | "completed";
  progressCurrent?: number;
  progressTotal?: number;
  location?: string;
  lastReadAt?: number;
  dwellSeconds?: number;
  startedAt?: number;
  completedAt?: number;
  /** 重要度打星（0-3） */
  rating?: number;
  metadata?: {
    vectorization?: BookVectorizationMeta;
    translation?: BookTranslationMeta;
    [k: string]: any;
  };
}

export interface BookWithStatus extends SimpleBook {
  status?: BookStatus;
}

export interface BookWithUrls extends SimpleBook {
  fileUrl: string;
  coverUrl?: string;
}

export interface BookWithStatusAndUrls extends BookWithStatus {
  fileUrl: string;
  coverUrl?: string;
}

export type BookFormat = "EPUB" | "PDF" | "MOBI" | "CBZ" | "FB2" | "FBZ" | "MARKDOWN";

// ---- Vectorization metadata (stored under book_status.metadata.vectorization) ----
export type VectorizationStatus = "idle" | "processing" | "success" | "failed";

export interface BookVectorizationMeta {
  status: VectorizationStatus;
  model: string;
  dimension: number;
  chunkCount: number;
  version: number;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
}

// ---- Translation metadata (stored under book_status.metadata.translation) ----
export type BookTranslationStatus = "idle" | "processing" | "complete" | "partial" | "failed";

export interface BookTranslationMeta {
  status: BookTranslationStatus;
  /** 全书可翻译段总数（最近一次运行） */
  totalBlocks: number;
  /** 已有译文的段数（含历史续翻累计） */
  doneBlocks: number;
  /** 有译本的章数 */
  sectionCount: number;
  /** 重试后仍失败的批次数（这些段未落盘，续翻可补齐） */
  failedBatches?: number;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
}
