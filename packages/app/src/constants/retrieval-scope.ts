/** 用户划定的检索范围（阅读助手 / 论文助手各三档；角色决定每一档的实际含义）。
 *  - current：只读当前文档（阅读=本书，论文=本篇）
 *  - library：当前角色的资料库（阅读=图书馆全部书籍，论文=论文库全部论文）
 *  - all：书库 + 论文库（阅读/论文两个助手各自的最广档）
 * 全局助手没有下拉，恒为 all，不受此类型约束。
 */
export type RetrievalScope = "current" | "library" | "all";

export type RetrievalScopeRole = "reader" | "paper";

/** 仅用于缺失记录的读取回退；不要借此回填或改写已持久化的 scopes。 */
export function defaultRetrievalScope(role: RetrievalScopeRole | "central"): RetrievalScope {
  if (role === "paper") return "library";
  if (role === "central") return "all";
  return "current";
}

/** Legacy paperSearch 只能表达本篇或全部论文；all 中的书籍无法由旧工具表达。 */
export function legacyPaperScopeIds(scope: RetrievalScope, paperId: string): string[] | null {
  return scope === "current" ? [paperId] : null;
}

const RETRIEVAL_SCOPE_ORDER: Record<RetrievalScope, number> = {
  current: 0,
  library: 1,
  all: 2,
};

export const RETRIEVAL_SCOPE_LABELS: Record<RetrievalScopeRole, Record<RetrievalScope, string>> = {
  reader: {
    current: "本书",
    library: "图书馆",
    all: "图书馆+论文库",
  },
  paper: {
    current: "本篇",
    library: "论文库",
    all: "论文库+图书馆",
  },
};

export const RETRIEVAL_SCOPE_DESCRIPTIONS: Record<RetrievalScopeRole, Record<RetrievalScope, string>> = {
  reader: {
    current: "只检索/读取当前这本书",
    library: "可检索/读取图书馆全部书籍（不含论文）",
    all: "书籍与论文都可检索/读取",
  },
  paper: {
    current: "只检索/读取当前这篇论文",
    library: "可检索/读取论文库全部论文（不含书籍）",
    all: "论文与书籍都可检索/读取",
  },
};

export const RETRIEVAL_SCOPE_OPTIONS: Record<
  RetrievalScopeRole,
  { value: RetrievalScope; label: string; description: string }[]
> = {
  reader: (["current", "library", "all"] as const).map((value) => ({
    value,
    label: RETRIEVAL_SCOPE_LABELS.reader[value],
    description: RETRIEVAL_SCOPE_DESCRIPTIONS.reader[value],
  })),
  paper: (["current", "library", "all"] as const).map((value) => ({
    value,
    label: RETRIEVAL_SCOPE_LABELS.paper[value],
    description: RETRIEVAL_SCOPE_DESCRIPTIONS.paper[value],
  })),
};

export function isRetrievalScope(value: unknown): value is RetrievalScope {
  return value === "current" || value === "library" || value === "all";
}

/** 取更窄的一档：模型传入的 scope 只能在用户圈定范围内收窄，永远不能放大。 */
export function narrowRetrievalScope(circle: RetrievalScope, requested?: RetrievalScope): RetrievalScope {
  if (!requested) return circle;
  return RETRIEVAL_SCOPE_ORDER[requested] <= RETRIEVAL_SCOPE_ORDER[circle] ? requested : circle;
}
