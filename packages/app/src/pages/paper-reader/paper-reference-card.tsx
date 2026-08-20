import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { requestPaperQuoteLocate } from "@/services/paper-locate-service";
/**
 * 参考文献条目卡片（P2.2/P2.3 前端）：点击参考文献区条目弹出。
 * 展示 references.json 结构化字段 + 懒补全元数据（Crossref/OpenAlex，写回缓存）+ 在库状态；
 * 动作：在库 [打开]（openPaper + quote 定位总线）/ 不在库 [获取 PDF]（全链路沉全局转换进度层）
 * + [访问页面]（landing_page → doi.org → Scholar 兜底，永远可用）。
 */
import {
  type LibraryPaperHit,
  type PaperReference,
  type ReferenceEnrichment,
  checkReferenceInLibrary,
  enrichReference,
  referenceLandingUrl,
} from "@/services/paper-reference-service";
import { startPaperAcquireImport } from "@/store/convert-progress-store";
import { useLayoutStore } from "@/store/layout-store";
import { useMcpStore } from "@/store/mcp-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BookOpen, Download, ExternalLink, Loader } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

/** 虚拟锚点（Radix Popover.Anchor 的 virtualRef 约定形状）：定位到被点击的条目块 */
interface VirtualAnchor {
  getBoundingClientRect: () => DOMRect;
}

interface PaperReferenceCardProps {
  /** 当前打开的条目（references.json 中 n 对应项；null = 无卡片） */
  reference: PaperReference | null;
  /** 被点击条目块的 getBoundingClientRect 快照 */
  anchorRect: DOMRect | null;
  onOpenChange: (open: boolean) => void;
  /** 补全成功回传（调用方更新状态并写回 references.json 缓存） */
  onEnriched: (n: number, enrichment: ReferenceEnrichment) => void;
}

export function PaperReferenceCard({ reference, anchorRect, onOpenChange, onEnriched }: PaperReferenceCardProps) {
  const open = reference !== null && anchorRect !== null;
  // 补全结果：优先 references.json 缓存（enrichment 字段），否则开卡时懒请求
  const [enrichment, setEnrichment] = useState<ReferenceEnrichment | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [enrichFailed, setEnrichFailed] = useState(false);
  const [inLibrary, setInLibrary] = useState<LibraryPaperHit | null>(null);
  // 订阅 store 而非一次性读取：zustand 持久化经 tauriStorage 异步水合，useMemo 会在水合前误判未配置
  const zoteroAvailable = useMcpStore((s) =>
    s.servers.some((server) => server.enabled && server.name.toLowerCase().includes("zotero")),
  );

  const virtualAnchor = useMemo<VirtualAnchor | null>(
    () => (anchorRect ? { getBoundingClientRect: () => anchorRect } : null),
    [anchorRect],
  );

  // 元数据补全的重试触发器（退避耗尽/失败后可手动重试）
  const [enrichRetryNonce, setEnrichRetryNonce] = useState(0);

  // 开卡时：重置上一条状态；无缓存则懒补全（成功回传写缓存，失败降级 raw + Scholar 兜底）。
  // 所有网络路径都有超时/退避上限，enrichReference 恒 settle——失败落 enrichFailed 终止态
  // （静态文案 + 重试），不会无限转圈
  // biome-ignore lint/correctness/useExhaustiveDependencies: enrichRetryNonce 是刻意的重试触发依赖
  useEffect(() => {
    if (!reference) return;
    setEnrichment(reference.enrichment ?? null);
    setEnrichFailed(false);
    if (reference.enrichment) return;
    let cancelled = false;
    setEnriching(true);
    enrichReference(reference)
      .then((result) => {
        if (cancelled) return;
        if (result) {
          setEnrichment(result);
          onEnriched(reference.n, result);
        } else {
          setEnrichFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setEnriching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reference, onEnriched, enrichRetryNonce]);

  // 在库检查：DOI（含补全出的 DOI）精确 → 标题归一化模糊；开卡即查，补全到达后用更全字段复查
  useEffect(() => {
    if (!reference) return;
    let cancelled = false;
    checkReferenceInLibrary({
      doi: reference.doi ?? enrichment?.doi,
      title: enrichment?.title ?? reference.title,
    })
      .then((hit) => {
        if (!cancelled) setInLibrary(hit);
      })
      .catch((error) => console.warn("在库检查失败:", error));
    return () => {
      cancelled = true;
    };
  }, [reference, enrichment]);

  if (!reference || !virtualAnchor) return null;

  const title = enrichment?.title ?? reference.title;
  const authors = enrichment?.authors ?? reference.authors;
  const year = enrichment?.year ?? reference.year;
  const venue = enrichment?.venue ?? reference.venue;
  const doi = enrichment?.doi ?? reference.doi;
  const landingUrl = referenceLandingUrl(reference, enrichment);

  const handleOpenInLibrary = () => {
    if (!inLibrary) return;
    useLayoutStore.getState().openPaper(inLibrary.id, inLibrary.title);
    if (title) requestPaperQuoteLocate(inLibrary.id, title);
    onOpenChange(false);
  };

  const handleVisitPage = () => {
    openUrl(landingUrl).catch((error) => console.warn("打开落地页失败:", landingUrl, error));
  };

  const handleAcquirePdf = () => {
    // 全链路（Zotero Brain 下载 → 解析 → 入库）沉到全局转换进度层：
    // 下载阶段也进右下角进度卡（阅读/聊天页豁免，与既有可见性规则一致），结果 toast 通知。
    // title 只传真标题（无标题条目如 APS 老版式传空）——raw 引文切片会被 slim 的标题校验
    // 当作论文标题比对而误杀（"PDF 已下载但标题校验不符，丢弃"）；显示串另用 displayName 兜底
    void startPaperAcquireImport({
      doi,
      title,
      displayName: title ?? reference.raw.slice(0, 80),
      url: landingUrl,
      arxivId: reference.arxiv_id,
    });
    onOpenChange(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={{ current: virtualAnchor }} />
      <PopoverContent side="top" align="center" className="max-h-96 w-96 overflow-auto p-0">
        <div className="flex max-h-[384px] flex-col overflow-hidden bg-muted/80">
          {/* 头部：标题（补全优先）+ 在库徽标 */}
          <div className="border-b px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex-1 truncate font-medium text-foreground text-sm">
                    {title ?? `参考文献 [${reference.n}]`}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom">{title ?? reference.raw}</TooltipContent>
              </Tooltip>
              {inLibrary && (
                <span className="flex-shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-green-700 text-xs dark:bg-green-900/50 dark:text-green-300">
                  已在库中
                </span>
              )}
            </div>
          </div>

          <div className="flex-1 space-y-2 overflow-auto p-3 text-sm">
            {/* 结构化字段 */}
            {authors && authors.length > 0 && (
              <p className="text-neutral-600 dark:text-neutral-400">{authors.join(", ")}</p>
            )}
            {(year || venue) && (
              <p className="text-neutral-500 text-xs dark:text-neutral-500">
                {[venue, year].filter(Boolean).join(", ")}
              </p>
            )}
            {doi && (
              <button
                type="button"
                className="block break-all text-left text-blue-600 text-xs hover:underline dark:text-blue-400"
                onClick={() => openUrl(`https://doi.org/${doi}`).catch(() => {})}
              >
                https://doi.org/{doi}
              </button>
            )}

            {/* 摘要 / 解析状态（所有失败/超时路径都有终止态：退避耗尽后落静态文案 + 重试，不无限转圈） */}
            {enriching ? (
              <p className="flex items-center gap-1.5 text-neutral-500 text-xs dark:text-neutral-400">
                <Loader className="size-3 animate-spin" />
                正在补全元数据（限流时自动退避重试）…
              </p>
            ) : enrichment?.abstract ? (
              <p className="line-clamp-6 text-justify text-neutral-600 text-xs leading-relaxed dark:text-neutral-400">
                {enrichment.abstract}
              </p>
            ) : enrichFailed ? (
              <p className="text-neutral-500 text-xs dark:text-neutral-400">
                未获取到元数据（可能网络限流），可稍后{" "}
                <button
                  type="button"
                  className="text-blue-600 hover:underline dark:text-blue-400"
                  onClick={() => setEnrichRetryNonce((v) => v + 1)}
                >
                  重试
                </button>{" "}
                或经{" "}
                <button
                  type="button"
                  className="text-blue-600 hover:underline dark:text-blue-400"
                  onClick={() =>
                    openUrl(
                      `https://scholar.google.com/scholar?q=${encodeURIComponent(title ?? reference.raw.slice(0, 120))}`,
                    ).catch(() => {})
                  }
                >
                  Scholar 搜索
                </button>
              </p>
            ) : null}

            {/* raw 条目原文（始终展示，结构化字段缺失时的保底信息） */}
            <p className="break-words border-neutral-200 border-l-2 pl-2 text-neutral-500 text-xs leading-relaxed dark:border-neutral-700 dark:text-neutral-400">
              {reference.raw}
            </p>
          </div>

          {/* 动作行：在库 [打开]；不在库 [获取 PDF] + [访问页面]（后者永远可用） */}
          <div className="flex items-center justify-end gap-1.5 border-t px-3 py-2">
            {inLibrary ? (
              <Button size="sm" variant="soft" className="h-7 text-xs" onClick={handleOpenInLibrary}>
                <BookOpen className="size-3.5" />
                打开
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* disabled 按钮不触发 tooltip，包一层 span */}
                  <span className={!zoteroAvailable ? "cursor-not-allowed" : undefined}>
                    <Button
                      size="sm"
                      variant="soft"
                      className="h-7 text-xs"
                      disabled={!zoteroAvailable}
                      onClick={handleAcquirePdf}
                    >
                      <Download className="size-3.5" />
                      获取 PDF
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {zoteroAvailable ? "经 Zotero Brain 下载并解析入库" : "未配置 Zotero Brain：请到 AI 中心 → MCP 配置"}
                </TooltipContent>
              </Tooltip>
            )}
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={handleVisitPage}>
              <ExternalLink className="size-3.5" />
              访问页面
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
