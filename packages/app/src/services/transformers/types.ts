import type { ViewSettings } from "@/types/book";

export type TransformContext = {
  bookId: string;
  viewSettings: ViewSettings;
  content: string;
  transformers: string[];
  reversePunctuationTransform?: boolean;
  /** 当前内容对应的 spine 章序号（仅 XHTML 正文资源有；非 spine 资源/CSS 缺省） */
  sectionIndex?: number;
};

export type Transformer = {
  name: string;
  transform: (ctx: TransformContext) => Promise<string>;
};
