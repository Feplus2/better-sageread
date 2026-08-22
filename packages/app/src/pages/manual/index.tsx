import { Markdown } from "@/components/prompt-kit/markdown";
import { prepareManualFiles } from "@/services/manual-service";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { BookOpenText, CircleHelp } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * 使用手册页：渲染插件内嵌的手册 Markdown（resources/manual/*.md，prepareManualFiles 落盘后读取）。
 * 与 Agent 的 askAppHelp 共用同一份语料——用户看到的和助手检索到的是同一内容。
 */

interface ManualChapter {
  filename: string;
  /** 文件首个 # 标题（去掉「Better SageRead 使用手册 · 」前缀） */
  title: string;
  content: string;
  /** ## / ### 小节标题（左侧目录的跳转锚） */
  headings: string[];
}

function parseChapter(filename: string, content: string): ManualChapter {
  const lines = content.split("\n");
  const h1 = lines.find((l) => l.startsWith("# "))?.replace(/^#\s*/, "") ?? filename;
  const title = h1.replace(/^Better SageRead 使用手册\s*·\s*/, "");
  const headings = lines.filter((l) => /^#{2,3}\s/.test(l)).map((l) => l.replace(/^#{2,3}\s*/, "").trim());
  return { filename, title, content, headings };
}

export default function ManualPage() {
  const [chapters, setChapters] = useState<ManualChapter[]>([]);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const dir = await prepareManualFiles();
        const entries = (await readDir(dir))
          .filter((e) => e.isFile && e.name.endsWith(".md"))
          .sort((a, b) => a.name.localeCompare(b.name));
        const list: ManualChapter[] = [];
        for (const entry of entries) {
          list.push(parseChapter(entry.name, await readTextFile(`${dir}/${entry.name}`)));
        }
        setChapters(list);
      } catch (e) {
        console.error("加载使用手册失败:", e);
        setError(String(e));
      }
    })();
  }, []);

  const chapter = chapters[selected];

  const jumpToHeading = (headingIndex: number) => {
    const container = contentRef.current;
    if (!container) return;
    const els = container.querySelectorAll("h2, h3");
    const el = els[headingIndex];
    el?.scrollIntoView({ block: "start" });
  };

  const chapterList = useMemo(() => chapters, [chapters]);

  return (
    <div className="flex h-full min-h-0">
      {/* 左：章节目录 */}
      <aside className="w-56 shrink-0 overflow-y-auto border-neutral-200 border-r p-3 dark:border-neutral-800">
        <div className="mb-3 flex items-center gap-2 px-1 text-neutral-500 dark:text-neutral-400">
          <CircleHelp className="size-4" />
          <span className="font-medium text-xs">使用手册</span>
        </div>
        <nav className="space-y-0.5">
          {chapterList.map((c, i) => (
            <div key={c.filename}>
              <button
                type="button"
                onClick={() => setSelected(i)}
                className={`w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                  i === selected
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                }`}
              >
                {c.title}
              </button>
              {i === selected && c.headings.length > 0 && (
                <div className="mt-0.5 mb-1 ml-3 space-y-0.5 border-neutral-200 border-l pl-2 dark:border-neutral-700">
                  {c.headings.map((h, hi) => (
                    <button
                      key={h}
                      type="button"
                      onClick={() => jumpToHeading(hi)}
                      className="block w-full truncate text-left text-neutral-500 text-xs transition-colors hover:text-primary dark:text-neutral-400"
                    >
                      {h}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
      </aside>

      {/* 右：正文（chat 同款主题 Markdown 渲染） */}
      <div ref={contentRef} className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
        {error && <p className="text-red-500 text-sm">手册加载失败：{error}</p>}
        {!error && !chapter && (
          <div className="flex h-full items-center justify-center text-neutral-400 text-sm">
            <BookOpenText className="mr-2 size-4" /> 手册加载中…
          </div>
        )}
        {chapter && (
          <Markdown className="chat-md prose mx-auto prose-headings:my-2 prose-p:my-1.5 max-w-3xl pb-10 prose-table:text-xs text-foreground text-sm leading-relaxed">
            {chapter.content}
          </Markdown>
        )}
      </div>
    </div>
  );
}
