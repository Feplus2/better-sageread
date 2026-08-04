import type { CustomTheme } from "@/styles/themes";
import type { HighlightColor, HighlightStyle, ViewSettings } from "./book";

export type LibraryViewModeType = "grid" | "list";
export type LibrarySortByType = "title" | "author" | "updated" | "created" | "size" | "format";
export type LibraryCoverFitType = "crop" | "fit";
/** 论文阅读显示模式：原文 / 译文 / 逐段对照 */
export type PaperViewModeType = "original" | "translated" | "bilingual";
/** 文献库列表元数据语言：原文 / 中文（用已翻译的 title_zh/abstract_zh 显示） */
export type PapersMetaLangType = "original" | "zh";
/** 文献库列表排序：导入时间 / 重要度（打星）/ 标题 */
export type PapersSortByType = "updated" | "created" | "rating" | "title";

export interface ReadSettings {
  sideBarWidth: string;
  isSideBarPinned: boolean;
  notebookWidth: string;
  isNotebookPinned: boolean;
  autohideCursor: boolean;
  translationProvider: string;
  translateTargetLang: string;

  highlightStyle: HighlightStyle;
  highlightStyles: Record<HighlightStyle, HighlightColor>;
  customThemes: CustomTheme[];
}

export interface SystemSettings {
  version: number;
  localBooksDir: string;

  keepLogin: boolean;
  autoUpload: boolean;
  alwaysOnTop: boolean;
  openBookInNewWindow: boolean;
  autoCheckUpdates: boolean;
  screenWakeLock: boolean;
  alwaysShowStatusBar: boolean;
  openLastBooks: boolean;
  lastOpenBooks: string[];
  autoImportBooksOnOpen: boolean;
  telemetryEnabled: boolean;
  libraryViewMode: LibraryViewModeType;
  librarySortBy: LibrarySortByType;
  librarySortAscending: boolean;
  libraryCoverFit: LibraryCoverFitType;
  paperViewMode: PaperViewModeType;
  /** 文献库列表元数据语言（默认原文） */
  papersMetaLang?: PapersMetaLangType;
  /** 文献库列表排序（默认导入时间倒序） */
  papersSortBy?: PapersSortByType;
  papersSortAscending?: boolean;

  lastSyncedAtBooks: number;
  lastSyncedAtConfigs: number;
  lastSyncedAtNotes: number;

  globalReadSettings: ReadSettings;
  globalViewSettings: ViewSettings;
}
