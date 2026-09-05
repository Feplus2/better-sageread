/**
 * sciverseSearch 证据片段查看器：论文标题 + 命中原文片段 + 出处坐标（页码/相关度），
 * expand 命中的扩读上下文折叠展示。证据片段无公网链接可跳（doc_id 是库内坐标），
 * 故卡片不可点击——与 WebSearchViewer 的外链卡片形态区分。
 */
import { Quote } from "lucide-react";
import { memo } from "react";

interface SciverseEvidenceItem {
  title: string;
  docId: string;
  score: number;
  offset: number;
  pageNo: number | null;
  abstract: string;
  text: string;
  context: string | null;
  contextMore: boolean | null;
}

interface SciverseViewerProps {
  results: SciverseEvidenceItem[];
}

const SciverseViewerComponent = ({ results }: SciverseViewerProps) => {
  if (!results || results.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-neutral-500 text-sm dark:text-neutral-400">暂无证据片段</p>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex-1 space-y-2 overflow-auto p-3">
        {results.map((item, index) => (
          <div
            key={`${item.docId}-${index}`}
            className="rounded-lg border border-neutral-200 px-3 py-2.5 dark:border-neutral-700"
          >
            <div className="flex items-start gap-2">
              <span className="line-clamp-2 flex-1 font-medium text-neutral-800 text-sm dark:text-neutral-100">
                {item.title || "未命名文献"}
              </span>
              <span className="mt-0.5 shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-500 text-xs dark:bg-neutral-800 dark:text-neutral-400">
                {Math.round((item.score || 0) * 100)}%
              </span>
            </div>
            <p className="mt-1 text-neutral-500 text-xs dark:text-neutral-400">
              {item.pageNo != null ? `第 ${item.pageNo} 页 · ` : ""}偏移 {item.offset}
            </p>
            {item.text && (
              <div className="mt-1.5 flex gap-1.5">
                <Quote className="mt-0.5 size-3 shrink-0 text-neutral-400" />
                <p className="whitespace-pre-wrap text-neutral-600 text-xs leading-5 dark:text-neutral-300">
                  {item.text}
                </p>
              </div>
            )}
            {item.context && (
              <details className="mt-1.5">
                <summary className="cursor-pointer text-primary text-xs hover:underline">
                  原文上下文{item.contextMore ? "（还有后续）" : ""}
                </summary>
                <p className="mt-1 whitespace-pre-wrap border-neutral-200 border-l-2 pl-2 text-neutral-600 text-xs leading-5 dark:border-neutral-700 dark:text-neutral-300">
                  {item.context}
                </p>
              </details>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export const SciverseViewer = memo(SciverseViewerComponent);
