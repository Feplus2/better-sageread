import { getDocumentToolMode } from "@/ai/tools/document/mode";
import { appDataDir } from "@tauri-apps/api/path";

/**
 * 文献库导航约定（P0，2026-10-22 模式感知）：静态段注入三个 scope 的系统提示词。
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
  const docMode = getDocumentToolMode();
  return [
    "—— 文献库导航约定 ——",
    `文献库根：${root}（只读）。书籍与论文各占一个目录：`,
    "• 书籍：<book_id>/book.epub + mdbook/book/src/text/*.md + images/；没有 mdbook 的旧书按 EPUB 解析。",
    "• 论文：<paper_id>/paper.md + images/。",
    "探索顺序：目录/元信息 → 检索（语义问题用检索工具；精确术语可先查工作区文件）→ 按锚点读原文窗口 → 需要看图时用 readImage(path=绝对路径)。",
    "图片：Markdown 里的相对路径不是本地文件路径。论文助手与全局助手可用 getFigures 拿论文图片清单（image_path；全局助手必须显式传 doc=paper:<paper_id>）；书籍没有独立图片清单工具，请使用检索或原文结果里给出的绝对图片路径。拿到路径后用 readImage 看内容；没有真正调用 readImage 时，不要声称自己看过图。",
    "看图策略：图片会进入上下文并在后续每步重复计费——先读图注/正文，确需视觉细节时再看图；多图对比可以连续看，但看完尽快作答；默认长边 1024，小字看不清可升到 1536（更大请改用图注/正文，请求会明显变慢）。",
    "文献库只读：不要用 runCommand/dir/python 到文献库目录里翻文件。找文档用元数据/检索工具，读正文用原文读取工具；导入、删除、翻译、向量化属于全局助手的事务，引导用户去全局助手。",
    docMode === "legacy"
      ? "跨文档：旧版模式的通用直读仅限当前助手已绑定的文档；未绑定或需要跨文档时，不承诺可直读。不要用 readLocalFile/runCommand 到文献库目录翻文件。"
      : "跨文档：readDocument 可读的文档由用户在侧栏选定的检索范围决定（见【检索范围】段）；越界 doc 会被拒绝，不要用 readLocalFile/runCommand 绕过工具硬读路径。全局助手不受范围限制。",
    docMode === "legacy"
      ? "未索引文档：旧版工具不能用语义检索时，只有当前助手实际提供原文读取工具才按目录或当前位置直读；若没有相应工具，明确说明能力限制，不要声称已读取或检索。读取时只看目标小节/位置，并提醒用户向量化后可提速。"
      : "未索引文档：getDocumentInfo 的 index.status=not_indexed 表示没有向量索引。searchLibrary 仍可用关键词/标题回退，与目录读取互补：精确术语先检索，回退无命中或需要完整上下文时再 getDocumentInfo 拿目录、readDocument 读目标小节/位置的 1-2 个窗口；library/all 若 partial 且带 next_cursor，用相同 query/参数和该 cursor 继续扫描后续文档，直到游标消失，不要重复首页结果。正常读、不要拒答，不要整章通读。回答时提醒用户向量化后可显著提速。",
    docMode === "legacy"
      ? "跨库检索：旧版模式不承诺跨库检索；只有当前助手实际注册相应检索工具且具备所需能力时才可执行，否则明确说明限制，不要声称已检索书库或论文库。"
      : "跨库检索：searchLibrary 的检索范围同样受用户选择约束（见【检索范围】）；中央助手范围最大（书库+论文库，RRF 融合），结果带 kind=book/paper 标记。",
    "引用规范：正文引用给章节标题；图表引用给图号/表号；参考文献给编号；不得编造页码或图中不存在的细节。",
  ].join("\n");
}
