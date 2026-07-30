/**
 * 一致性测试渲染入口：与 PaperReader 完全相同的 remark/rehype 链
 * （remarkGfm + remarkMath → rehypeRaw + rehypeKatex + rehypeSlug），
 * 用 react-dom/server 把论文正文渲染为静态 HTML，供 scripts/test-paper-blocks-consistency.mjs
 * 在 jsdom 中跑 listBlocks 枚举并与切块器输出逐块比对。
 * 不带 PaperReader 的自定义 img/a 组件（blob 加载依赖 Tauri fs；渲染产物对块枚举无影响）。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

export function renderPaperBody(body: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm, remarkMath],
        rehypePlugins: [rehypeRaw, rehypeKatex, rehypeSlug],
      },
      body,
    ),
  );
}
