import { InlineMathText } from "@/components/markdown/inline-math-text";
import { readFile } from "@tauri-apps/plugin-fs";
import { Image as ImageIcon, Table as TableIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type PaperFigureItem, extractPaperFigures } from "./paper-blocks";

/** hover 缩略图的 blob URL 缓存（模块级，按"目录/相对路径"键控；与正文 PaperImage 的缓存各自独立，重复读一次但免耦合） */
const thumbCache = new Map<string, string>();

/** 缩略图取组内最后一张图：合并产物中整图最靠近图注（figure_merger 输出顺序），无图注组取首图语义上无差别 */
const thumbSrcOf = (item: PaperFigureItem) => item.images.at(-1) ?? null;

function useThumbUrl(paperDir: string, src: string | null): string | null {
  const [url, setUrl] = useState<string | null>(src ? (thumbCache.get(`${paperDir}/${src}`) ?? null) : null);

  useEffect(() => {
    if (!src) {
      setUrl(null);
      return;
    }
    const key = `${paperDir}/${src}`;
    const cached = thumbCache.get(key);
    if (cached) {
      setUrl(cached);
      return;
    }
    let cancelled = false;
    readFile(key)
      .then((bytes) => {
        if (cancelled) return;
        const blobUrl = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer]));
        thumbCache.set(key, blobUrl);
        setUrl(blobUrl);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [paperDir, src]);

  return url;
}

interface PaperFigureItemRowProps {
  item: PaperFigureItem;
  paperDir: string;
  /** 块译文（translation-zh.json，键 = 图注块索引）；有则并列显示一行 */
  translation?: string;
  onLocate: () => void;
}

/** 图表列表项：编号徽章 + 图注（含行内公式渲染）+ 译文行；hover 出缩略图（面板左侧浮层，不拦截指针） */
function PaperFigureItemRow({ item, paperDir, translation, onLocate }: PaperFigureItemRowProps) {
  const thumbSrc = thumbSrcOf(item);
  const thumbUrl = useThumbUrl(paperDir, thumbSrc);
  const KindIcon = item.kind === "figure" ? ImageIcon : TableIcon;

  return (
    <div
      className="group relative cursor-pointer rounded-lg bg-muted p-2 transition-colors hover:bg-neutral-200/60 dark:bg-neutral-900 dark:hover:bg-neutral-800"
      onClick={onLocate}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 font-medium text-primary text-xs">
          <KindIcon className="size-3" />
          {item.label}
        </span>
        <div className="min-w-0 flex-1">
          {item.caption ? (
            <InlineMathText text={item.caption} className="line-clamp-2 text-sm leading-relaxed" />
          ) : (
            <span className="text-neutral-400 text-xs dark:text-neutral-500">
              无图注{item.images.length > 1 ? `，共 ${item.images.length} 张图` : ""}
            </span>
          )}
          {translation && (
            <InlineMathText
              text={translation}
              className="mt-0.5 line-clamp-1 text-neutral-500 text-xs leading-relaxed dark:text-neutral-400"
            />
          )}
        </div>
      </div>
      {/* hover 缩略图：浮在面板左侧（阅读区上方），pointer-events-none 防抖动 */}
      {thumbUrl && (
        <div className="pointer-events-none absolute top-0 right-full z-50 mr-2 hidden w-56 group-hover:block">
          <img
            src={thumbUrl}
            alt={item.label}
            className="max-h-64 w-full rounded-lg border border-neutral-200 bg-background object-contain shadow-lg dark:border-neutral-700"
          />
        </div>
      )}
    </div>
  );
}

export interface PaperFiguresTabProps {
  /** paper.md 原始文本（未加载完成为 null） */
  markdown: string | null;
  /** 论文目录绝对路径（缩略图图片相对路径基于它解析） */
  paperDir: string;
  /** 块译文表（translation-zh.json；无译本/未加载为 null） */
  translationMap: ReadonlyMap<number, string> | null;
  /** 点击条目 → 正文滚动定位 + 闪烁强调 */
  onLocate: (item: PaperFigureItem) => void;
}

/**
 * 「图表」tab：从 paper.md 运行时提取图/表注锚点（extractPaperFigures），
 * 点击速跳正文（组会/汇报场景的核心诉求），hover 出缩略图。不入库、零数据层改动。
 */
export function PaperFiguresTab({ markdown, paperDir, translationMap, onLocate }: PaperFiguresTabProps) {
  const items = useMemo(() => (markdown ? extractPaperFigures(markdown) : []), [markdown]);

  if (!markdown) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-center text-neutral-400 text-sm dark:text-neutral-500">论文内容加载中…</p>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-center text-neutral-400 text-sm leading-relaxed dark:text-neutral-500">
          暂无可识别的图表
          <br />
          <span className="text-xs">从 paper.md 中提取图注/表注锚点，点击可速跳到正文对应位置</span>
        </p>
      </div>
    );
  }
  return (
    <div className="flex-1 space-y-2 overflow-y-auto p-2">
      {items.map((item, index) => (
        <PaperFigureItemRow
          key={`${item.kind}-${item.num ?? `u${index}`}`}
          item={item}
          paperDir={paperDir}
          translation={translationMap?.get(item.blockIndex)}
          onLocate={() => onLocate(item)}
        />
      ))}
    </div>
  );
}
