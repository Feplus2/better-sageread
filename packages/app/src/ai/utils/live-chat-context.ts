import type { ChatContext } from "@/hooks/use-chat-state";

/**
 * 活上下文注册表（2026-08-23，位置感知冻结 bug 的结构性修复）：
 * 实测出现“面板 ref 已更新、发送的 chatContext 却停在挂载初值”的 heisenbug
 * （插桩即自愈，指向 ref/闭包/HMR 模块分裂一整类陈旧捕获）。本表以模块级
 * 单例做兜底事实源：面板每次渲染无条件写入本 scope 最新快照，
 * transport 在 body 未携带 chatContext 时按 scopeHint 兜底读取——
 * 没有闭包捕获、没有 useEffect 时序，任何一条旧链断裂都兜得住。
 * 语义：按 scope 取“最后渲染的面板”快照；同 scope 多 tab 时以可见面板为准
 * （切 tab 必触发可见面板重渲染，快照随之刷新）。
 */
const live = new Map<string, ChatContext>();

export function setLiveChatContext(context: ChatContext): void {
  if (context?.agentScope) live.set(context.agentScope, context);
}

export function getLiveChatContext(scope: string | undefined): ChatContext | undefined {
  return scope ? live.get(scope) : undefined;
}
