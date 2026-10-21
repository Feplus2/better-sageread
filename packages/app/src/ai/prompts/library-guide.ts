import { appDataDir } from "@tauri-apps/api/path";

/**
 * 文献库导航约定（P0）：静态段注入三个 scope 的系统提示词。
 * 目标：把「库在哪、怎么探索、图片怎么看、边界在哪」从每个工具的 description 里上移成一份约定，
 * 减少工具选择成本；同时直接消掉 G1 基线里的失败模式（命令行翻 appData、相对路径当文件路径、只看图注猜图）。
 */

let cachedRoot: string | null = null;

async function resolveLibraryRoot(): Promise<string> {
  if (cachedRoot) return cachedRoot;
  try {
    const base = await appDataDir();
    cachedRoot = `${base.replace(/\\/g, "/")}/books`;
  } catch {
    cachedRoot = "<appData>/books";
  }
  return cachedRoot;
}

export async function buildLibraryGuide(): Promise<string> {
  const root = await resolveLibraryRoot();
  return [
    "—— 文献库导航约定 ——",
    `文献库根：${root}（只读）。书籍与论文各占一个目录：`,
    "• 书籍：<book_id>/book.epub + mdbook/book/src/text/*.md + images/；没有 mdbook 的旧书按 EPUB 解析。",
    "• 论文：<paper_id>/paper.md + images/。",
    "探索顺序：目录/元信息 → 检索（语义问题用检索工具；精确术语可先查工作区文件）→ 按锚点读原文窗口 → 需要看图时用 readImage(path=绝对路径)。",
    "图片：Markdown 里的相对路径不是本地文件路径。先取图片清单（getFigures）拿到 image_path，再用 readImage 看内容；没有真正调用 readImage 时，不要声称自己看过图。",
    "看图策略：图片会进入上下文并在后续每步重复计费——先读图注/正文，确需视觉细节时再看图；看完立即作答，一轮最多看 1-2 张；默认 maxEdge=1024，小字看不清再升到 1536-2048。",
    "文献库只读：不要用 runCommand/dir/python 到文献库目录里翻文件。找文档用元数据/检索工具，读正文用原文读取工具；导入、删除、翻译、向量化属于全局助手的事务，引导用户去全局助手。",
    "跨文档：reader/paper scope 只有当前文档。需要看库里其它书/论文时，用全库检索工具（如 paperSearch 的全库范围）或请用户切到对应文档，不要绕过工具硬读路径。",
    "引用规范：正文引用给章节标题；图表引用给图号/表号；参考文献给编号；不得编造页码或图中不存在的细节。",
  ].join("\n");
}
