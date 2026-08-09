/**
 * webSearch 结构化结果查看器（E2）：标题/链接/摘要卡片列表，点击走 plugin-opener 开外链。
 * 复用聊天页右侧滑出容器，不加新依赖。
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink } from "lucide-react";
import { memo } from "react";

interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

interface WebSearchViewerProps {
  results: WebSearchResultItem[];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const WebSearchViewerComponent = ({ results }: WebSearchViewerProps) => {
  if (!results || results.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-neutral-500 text-sm dark:text-neutral-400">暂无搜索结果</p>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex-1 space-y-2 overflow-auto p-3">
        {results.map((item, index) => (
          <button
            key={`${item.url}-${index}`}
            type="button"
            onClick={() => {
              openUrl(item.url).catch(() => {});
            }}
            className="block w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-left transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800/60"
          >
            <div className="flex items-start gap-2">
              <span className="line-clamp-2 flex-1 font-medium text-neutral-800 text-sm dark:text-neutral-100">
                {item.title || item.url}
              </span>
              <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-neutral-400" />
            </div>
            <p className="mt-1 truncate text-neutral-500 text-xs dark:text-neutral-400">{hostOf(item.url)}</p>
            {item.snippet && (
              <p className="mt-1 line-clamp-3 text-neutral-600 text-xs dark:text-neutral-300">{item.snippet}</p>
            )}
          </button>
        ))}
      </div>
    </div>
  );
};

export const WebSearchViewer = memo(WebSearchViewerComponent);
