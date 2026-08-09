import type { UIMessage } from "@ai-sdk/react";

/** 单条消息的固定结构开销（role/分隔等），经验值 */
const MESSAGE_OVERHEAD_TOKENS = 8;
/** 单个字符串叶子计入估算的长度上限（截断采样），防超长文本拖慢估算 */
const PART_TEXT_CAP = 10_000;

// CJK 统一表意文字（U+4E00-U+9FFF、扩展A U+3400-U+4DBF、兼容区 U+F900-U+FAFF）
// + 日文假名（U+3040-U+30FF）+ 韩文音节（U+AC00-U+D7A3）
const CJK_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힣]/g;

/**
 * 粗估文本 token 数：CJK 字符按 ≈1 token/字，其余按 ≈1 token/4 字符。
 * 用于上下文窗口预算选择，不求精确，只求量级正确且单调。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = (text.match(CJK_RE) || []).length;
  const otherCount = text.length - cjkCount;
  return Math.ceil(cjkCount + otherCount / 4);
}

/** 结构探针单次估算最多访问的节点数（防巨型 tool 结果拖慢估算） */
const PROBE_NODE_BUDGET = 200;
/** 结构探针每层最多采样的键/项数，超出按已访均值外推 */
const PROBE_SAMPLE_LIMIT = 50;
/** 结构探针递归深度上限，更深层按常数摊薄 */
const PROBE_MAX_DEPTH = 4;

/**
 * 廉价探针估算任意值的 token 占用：字符串叶子做 CJK 感知估算（截断采样），
 * 对象/数组在节点预算内采样外推——绝不 JSON.stringify
 * （工具结果可达几十 MB，每次发送消息都全量序列化会冻结主线程）。
 */
function probeTokens(value: unknown, depth: number, budget: { left: number }): number {
  if (budget.left <= 0) return 8; // 预算耗尽：未访节点按常数摊薄
  budget.left -= 1;
  if (value == null) return 1;
  const t = typeof value;
  if (t === "string") return estimateTokens((value as string).slice(0, PART_TEXT_CAP));
  if (t === "number" || t === "boolean") return 2;
  if (t !== "object") return 1;
  if (depth <= 0) return 64;
  if (Array.isArray(value)) {
    const arr = value as unknown[];
    const n = Math.min(arr.length, PROBE_SAMPLE_LIMIT);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += probeTokens(arr[i], depth - 1, budget);
    return arr.length <= n ? sum : Math.ceil((sum / Math.max(n, 1)) * arr.length);
  }
  // for-in 计数不建键数组，避免巨型对象的全量键分配
  let sum = 0;
  let visited = 0;
  let total = 0;
  for (const key in value as Record<string, unknown>) {
    total += 1;
    if (visited < PROBE_SAMPLE_LIMIT) {
      sum += estimateTokens(key) + probeTokens((value as Record<string, unknown>)[key], depth - 1, budget);
      visited += 1;
    }
  }
  return total <= visited ? sum : Math.ceil((sum / Math.max(visited, 1)) * total);
}

/** 估算单个 part 的 token 占用（tool 部分按输入/输出做结构探针估算） */
function estimatePartTokens(part: unknown): number {
  if (!part || typeof part !== "object") return 0;
  const p = part as Record<string, unknown>;
  if (typeof p.text === "string") return estimateTokens(p.text.slice(0, PART_TEXT_CAP));
  // tool-* parts：输入/输出才是大头
  if (typeof p.type === "string" && p.type.startsWith("tool-")) {
    try {
      return (
        probeTokens(p.input, PROBE_MAX_DEPTH, { left: PROBE_NODE_BUDGET }) +
        probeTokens(p.output, PROBE_MAX_DEPTH, { left: PROBE_NODE_BUDGET })
      );
    } catch {
      return 0;
    }
  }
  return 0;
}

/** 估算单条消息的 token 占用（含固定结构开销） */
export function estimateMessageTokens(message: UIMessage): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  for (const part of parts) {
    tokens += estimatePartTokens(part);
  }
  return tokens;
}

/** 估算整段消息列表的 token 占用 */
export function estimateMessagesTokens(messages: UIMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message);
  }
  return total;
}
