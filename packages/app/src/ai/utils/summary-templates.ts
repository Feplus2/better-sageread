/**
 * D7 前情摘要分 scope 结构化（2026-08-21）：固定小节 > 自由摘要（恢复力强，业界 compaction 同款思路）。
 * 阅读场景以"理解进度"为主线（用户洞察：不一定有任务主线/重要发现，理解文本才是核心），
 * central 才沿用任务驱动的业界五段式。
 */

export type SummaryScope = "reader" | "paper" | "central";

interface SummaryTemplate {
  /** 模板名（日志/调试用） */
  name: string;
  /** 固定小节（模型输出必须逐节给出，无内容写"无"） */
  sections: string[];
  /** 该 scope 的侧重说明（拼进提示词） */
  focus: string;
}

const READER_TEMPLATE: SummaryTemplate = {
  name: "reader-理解进度",
  sections: ["在读书目与当前位置", "已讨论的核心概念与结论", "已澄清的疑问与纠偏记录", "用户理解偏好", "建议续聊方向"],
  focus:
    "阅读伴读场景：主线是“理解文本的进度”，不是任务进度——不一定有任务与待办，重点是概念理解的积累、用户认知被纠偏的地方、以及用户的理解偏好（类比习惯/要不要公式/语言深浅）。“纠偏记录”含作者观点与用户理解之间的偏差修正。",
};

const PAPER_TEMPLATE: SummaryTemplate = {
  name: "paper-论证结构",
  sections: [
    "论文与当前小节",
    "核心主张与已讨论部分的方法链",
    "已解释过的图表/公式/引用",
    "术语与符号约定",
    "待续问题与阅读线索",
  ],
  focus:
    "论文精读场景：主线是“论证结构的理解进度”——问题→方法→证据的链条推进到哪、哪些图表公式引用已经讲过（防止重复讲解）、跨轮一致的术语与符号译名。",
};

const CENTRAL_TEMPLATE: SummaryTemplate = {
  name: "central-任务五段式",
  sections: ["任务概览", "当前状态", "已做决定", "下一步", "需保留的偏好"],
  focus: "全局助手是任务驱动场景（书库管理/导入/配置等事务），沿用业界 compaction 五段式。",
};

export function summaryTemplateFor(scope: SummaryScope): SummaryTemplate {
  if (scope === "paper") return PAPER_TEMPLATE;
  if (scope === "central") return CENTRAL_TEMPLATE;
  return READER_TEMPLATE;
}

/** 组装滚动压缩提示词（纯函数，便于单测） */
export function buildScopedSummaryPrompt(params: {
  scope: SummaryScope;
  existingText: string | undefined;
  transcript: string;
  charLimit: number;
}): string {
  const { scope, existingText, transcript, charLimit } = params;
  const tpl = summaryTemplateFor(scope);
  const sectionList = tpl.sections.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `你是对话压缩器（${tpl.name}）。请把“既有摘要”与“新增对话片段”合并为一份更新后的滚动摘要。

场景侧重：${tpl.focus}

既有摘要：
${existingText?.trim() || "（无）"}

新增对话片段：
${transcript}

输出格式（必须逐节给出，无内容的小节写“无”）：
${sectionList}

要求：
1. 每节 1-3 句，总量不超过${charLimit}字；关键实体（书名/论文标题/章节名/文件路径/术语）原样保留
2. 既有摘要中已含的重要信息合并时注意保留，除非明确被更新内容取代（允许多轮压缩逐渐淡化，但避免骤然丢失）
3. 丢弃寒暄客套与已被取代的过时说法
4. 直接输出摘要本身（小节标题加粗），不要任何解释或前缀`;
}
