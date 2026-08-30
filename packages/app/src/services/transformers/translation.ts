import { loadBookTranslationSection } from "@/services/book-translation/book-translation-service";
import {
  enumerateSectionBlocks,
  injectSectionTranslations,
  parseSectionDocument,
  serializeSectionDocument,
} from "@/services/book-translation/section-blocks";
import type { Transformer } from "./types";

/**
 * 书籍对照翻译注入（docs/book-translation-plan.md 渲染通道）。
 *
 * 章节内容流入 iframe 前，按段序号把章译本插入原文段落后
 * （<div class="translation-target translation-target-block" data-book-translation>）。
 * 枚举与注入共用 section-blocks——与翻译服务同一段代码，段序号结构性不错位。
 *
 * 注入侧按段序号取译文、不校验 hash（上游 rawmath/punctuation 可能改写标点文本）；
 * 显示与否由 CSS 控制（getTranslationStyles 按 translationEnabled 编译），开关即时生效。
 * 无译本的章节原样返回（一次 exists 检查的开销）。
 */
export const translationTransformer: Transformer = {
  name: "translation",

  transform: async (ctx) => {
    if (ctx.sectionIndex === undefined || ctx.sectionIndex < 0) return ctx.content;
    const file = await loadBookTranslationSection(ctx.bookId, ctx.sectionIndex);
    if (!file || Object.keys(file.blocks).length === 0) return ctx.content;

    const parsed = parseSectionDocument(ctx.content);
    const blocks = enumerateSectionBlocks(parsed);
    if (blocks.length === 0) return ctx.content;
    const injected = injectSectionTranslations(parsed, blocks, file.blocks);
    if (injected === 0) return ctx.content;
    return serializeSectionDocument(parsed);
  },
};
