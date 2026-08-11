/**
 * 笔记面板（2026-08 重建）：绑定书籍/论文的长文 Markdown 笔记。
 * 与 BookNote（标注）是两套概念：标注 = 划词高亮 + 短评论；笔记 = 章节级长文产出。
 *
 * 位置三列分工：
 * - locationCfi：精确锚点（论文 = heading slug；书籍 = CFI）
 * - locationTag：文本兜底（论文 = heading 文本；书籍 = 章节标题），重解析漂移后退化文本匹配
 * - locationBlock：阅读流排序键（论文 = heading 在 TOC 的序号；书籍 = section 索引）
 */
export interface Note {
  id: string;
  bookId: string;
  title: string;
  /** Markdown 正文 */
  content: string;
  locationTag: string | null;
  locationBlock: number | null;
  locationCfi: string | null;
  starred: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface NoteCreateData {
  bookId: string;
  title?: string;
  content?: string;
  locationTag?: string | null;
  locationBlock?: number | null;
  locationCfi?: string | null;
}

/** 更新语义 = COALESCE：字段不传保留原值（清标题传空串） */
export interface NoteUpdateData {
  title?: string;
  content?: string;
  locationTag?: string | null;
  locationBlock?: number | null;
  locationCfi?: string | null;
  starred?: boolean;
}

/** 新建笔记时捕获的当前阅读位置（论文/书籍两侧各自装配） */
export interface NoteLocation {
  tag: string;
  cfi: string | null;
  block: number | null;
}

/** TOC 位置选择器条目：NoteLocation + 标题层级深度（缩进展示用，0 = 顶级） */
export interface NoteTocItem extends NoteLocation {
  depth: number;
}
