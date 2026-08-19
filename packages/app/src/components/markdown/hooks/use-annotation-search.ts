import {
  CitationFallbackContext,
  CitationMapContext,
  type CitationSource,
} from "@/components/markdown/citation-source";
import { useIsChatPage } from "@/hooks/use-is-chat-page";
import { useReaderStore } from "@/pages/reader/components/reader-provider";
import { requestPaperQuoteLocate } from "@/services/paper-locate-service";
import { listPapers } from "@/services/paper-service";
import { useChatReaderStore } from "@/store/chat-reader-store";
import { useLayoutStore } from "@/store/layout-store";
import type { BookSearchConfig, BookSearchResult } from "@/types/book";
import type { DocumentChunk } from "@/types/document";
import { createRejecttFilter } from "@/utils/node";
import { resolveMarkdownImagePaths } from "@/utils/path";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useContext, useState } from "react";
import { getBestSearchSentence } from "../text-utils";

export function useAnnotationSearch() {
  const [loading, setLoading] = useState(false);
  const [chunkData, setChunkData] = useState<DocumentChunk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  // 当前已取数片段的来源身份（决定弹窗标题与跳转路径：论文→全局论文库/打开论文 tab；书籍→foliate）
  const [source, setSource] = useState<CitationSource | null>(null);
  const isChatPage = useIsChatPage();

  // 消息级映射（工具结果重建）+ 面板级兜底（论文助手=当前论文）
  const citationMap = useContext(CitationMapContext);
  const citationFallback = useContext(CitationFallbackContext);

  const chatActiveBookId = useChatReaderStore((state) => state.activeBookId);
  const chatBookData = useChatReaderStore((state) => state.bookData);
  const chatConfig = useChatReaderStore((state) => state.config);

  const readerBookId = useReaderStore((state) => state.bookId);
  const readerBookData = useReaderStore((state) => state.bookData);
  const readerConfig = useReaderStore((state) => state.config);
  const readerView = useReaderStore((state) => state.view);
  const readerProgress = useReaderStore((state) => state.progress);

  const activeBookId = isChatPage ? chatActiveBookId : readerBookId;
  const bookData = isChatPage ? chatBookData : readerBookData;
  const config = isChatPage ? chatConfig : readerConfig;
  const view = isChatPage ? null : readerView;
  const progress = isChatPage ? null : readerProgress;

  /** chunkId → 来源：消息映射优先（跨文献准确），面板兜底其次，最后退回书籍阅读器/全局页的 store 书 id */
  const resolveSource = useCallback(
    (chunkId: string): CitationSource | null => {
      const mapped = citationMap?.get(Number(chunkId));
      if (mapped) return mapped;
      if (citationFallback) return citationFallback;
      if (activeBookId) return { kind: "book", bookId: activeBookId };
      return null;
    },
    [citationMap, citationFallback, activeBookId],
  );

  const fetchChunkData = useCallback(
    async (chunkId: string) => {
      const resolved = resolveSource(chunkId);
      const chunkIdNum = Number(chunkId);
      setSource(resolved);
      if (!Number.isInteger(chunkIdNum)) {
        setError("无效的引用标记");
        return;
      }
      if (!resolved) {
        setError("无法确定该引用的来源");
        return;
      }

      setLoading(true);
      setError(null);

      try {
        // 论文：全局论文库（papers/vectors.sqlite），chunk_id 全局唯一，无需 bookId
        const res =
          resolved.kind === "paper"
            ? ((await invoke("plugin:epub|get_paper_chunk_context", {
                chunkId: chunkIdNum,
                before: 0,
                after: 0,
              })) as DocumentChunk[])
            : ((await invoke("plugin:epub|get_chunk_with_context", {
                bookId: resolved.bookId,
                chunkId: chunkIdNum,
                prevCount: 0,
                nextCount: 0,
              })) as DocumentChunk[]);

        const chunk = res.find((c) => c.id === chunkIdNum) ?? res[0];
        if (chunk) {
          // 论文库 chunk_id 全局递增：无映射/兜底命中时 chunk 可能属于别的论文（老消息里
          // 模型写的非 chunk 引用标如 [1] 会撞中其他论文的分块）——按 paperId（md_file_path
          // 含 books/{paperId}）或标题校验归属，不符按失效处理，不展示错误内容
          const mismatch =
            resolved.kind === "paper" &&
            (resolved.paperId
              ? !!chunk.md_file_path && !chunk.md_file_path.includes(resolved.paperId)
              : !!resolved.title && !!chunk.book_title && chunk.book_title !== resolved.title);
          if (mismatch) {
            setError("该引用标指向的内容不属于当前论文（旧消息的引用可能已失效）");
            setLoading(false);
            return;
          }
          // md_file_path 现在存储的是绝对路径，可以直接用于图片路径解析
          if (chunk.md_file_path) {
            try {
              chunk.chunk_text = await resolveMarkdownImagePaths(chunk.chunk_text, chunk.md_file_path);
            } catch (error) {
              console.warn(`Failed to resolve image paths in chunk ${chunk.id}:`, error);
            }
          }
          setChunkData(chunk);
        } else {
          setError(resolved.kind === "paper" ? "未找到原文片段，论文库可能已重新向量化" : "未找到对应的文本片段");
        }
      } catch (e: any) {
        console.error("获取 chunk 数据失败:", e);
        const raw = typeof e === "string" ? e : e?.message || "获取文本片段失败";
        // Rust 侧 chunk 不存在时抛 "Query returned no rows"，翻译为准确的用户语义
        setError(raw.includes("no rows") ? "未找到原文片段（引用已失效或论文库已重建）" : raw);
      } finally {
        setLoading(false);
      }
    },
    [resolveSource],
  );

  const searchAndNavigate = useCallback(async () => {
    if (!chunkData || !source) return false;

    setSearching(true);
    setError(null);

    try {
      const searchQuery = getBestSearchSentence(chunkData.chunk_text);

      if (!searchQuery || searchQuery.length < 3) {
        setError("无法提取有效的搜索关键词");
        return false;
      }

      // 论文：打开/激活论文 tab + quote 定位总线（tab 未就绪时请求挂起，就绪自动重放）
      if (source.kind === "paper") {
        let paperId = source.paperId;
        // paperContext 的映射无 paper_id：按标题在本地论文清单解析一次
        if (!paperId && source.title) {
          try {
            const papers = await listPapers();
            paperId = papers.find((p) => p.title === source.title)?.id;
          } catch (error) {
            console.warn("按标题解析来源论文失败:", error);
          }
        }
        if (!paperId) {
          setError("无法确定来源论文（旧消息未携带来源信息）");
          return false;
        }
        useLayoutStore.getState().openPaper(paperId, chunkData.book_title || source.title || "论文");
        requestPaperQuoteLocate(paperId, searchQuery);
        return true;
      }

      const bookId = source.bookId ?? activeBookId;
      if (!bookId) {
        setError("无法确定该引用的来源");
        return false;
      }
      if (!view || !config || !bookData || !progress) {
        setError("阅读器未就绪，请稍后重试");
        return false;
      }

      try {
        view.clearSearch();
      } catch (e) {}

      const searchConfig = config.searchConfig as BookSearchConfig;
      const primaryLang = bookData.book?.primaryLanguage || "en";
      const { pageinfo } = progress;
      const index = searchConfig.scope === "section" ? pageinfo.current : undefined;

      view.setSearchIndicator("arrow", {
        color: "#ff4444",
        size: 24,
        animated: true,
        autoHide: true,
        hideDelay: 6000,
        offset: 15,
      });

      const generator = await view.search({
        ...searchConfig,
        index,
        query: searchQuery,
        acceptNode: createRejecttFilter({
          tags: primaryLang.startsWith("ja") ? ["rt"] : [],
        }),
      });

      const results: BookSearchResult[] = [];
      let foundFirst = false;

      for await (const result of generator) {
        if (typeof result === "string") {
          if (result === "done") {
            if (results.length === 0) {
              setError("未找到匹配的内容");
              return false;
            }
            return true;
          }
        } else {
          if (result.progress) {
          } else {
            results.push(result);

            if (!foundFirst) {
              foundFirst = true;
              let firstCfi: string | undefined;
              if ("subitems" in result && result.subitems && result.subitems.length > 0) {
                firstCfi = result.subitems[0].cfi;
              } else if ("cfi" in result) {
                firstCfi = (result as any).cfi;
              }

              if (firstCfi && view) {
                view.goTo(firstCfi);

                setTimeout(() => {
                  view.setSearchIndicator("outline", {});
                }, 100);
                return true;
              }
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      return false;
    } catch (e: any) {
      console.error("搜索失败:", e);
      setError(typeof e === "string" ? e : e?.message || "搜索失败");
      return false;
    } finally {
      setSearching(false);
    }
  }, [chunkData, source, activeBookId, view, config, bookData, progress]);

  return {
    loading,
    chunkData,
    error,
    searching,
    /** 当前片段的来源身份（弹窗决定跳转按钮显隐/标题展示用；取数前为 null） */
    source,
    fetchChunkData,
    searchAndNavigate,
    resetError: () => setError(null),
    resetChunkData: () => setChunkData(null),
  };
}
