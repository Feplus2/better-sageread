import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { type AgentConfirmRequest, useAgentConfirmStore } from "@/store/agent-confirm-store";
import { ShieldAlert } from "lucide-react";
import { useState } from "react";

/**
 * P1 Agent 确认卡：写工具/命令执行/网络外发需逐次确认时，在 central 聊天页输入区上方常驻渲染。
 * 队列式（ReAct 循环可能连续触发），逐张处理；"本次会话不再询问"按 工具名:路径/命令 记忆。
 */
export function AgentConfirmCard() {
  const queue = useAgentConfirmStore((s) => s.queue);
  const head = queue[0];
  if (!head) return null;
  return <ConfirmCardInner key={head.id} request={head} queueLength={queue.length} />;
}

function ConfirmCardInner({ request, queueLength }: { request: AgentConfirmRequest; queueLength: number }) {
  const resolvePending = useAgentConfirmStore((s) => s.resolvePending);
  const [dontAsk, setDontAsk] = useState(false);

  return (
    <div className="mb-2 rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="font-medium text-neutral-900 text-sm dark:text-neutral-100">
          {request.toolName} · {request.title}
        </span>
        {queueLength > 1 && (
          <span className="text-neutral-500 text-xs dark:text-neutral-400">（还有 {queueLength - 1} 项待确认）</span>
        )}
      </div>

      <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-background p-2 text-neutral-700 text-xs dark:bg-neutral-900 dark:text-neutral-300">
        {request.detail}
      </pre>

      <div className="mt-3 flex items-center justify-between">
        <label className="flex cursor-pointer items-center gap-1.5 text-neutral-500 text-xs dark:text-neutral-400">
          <Checkbox checked={dontAsk} onCheckedChange={(v) => setDontAsk(v === true)} />
          本次会话不再询问此项
        </label>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => resolvePending(false, false)} className="h-7 text-xs">
            拒绝
          </Button>
          <Button size="sm" onClick={() => resolvePending(true, dontAsk)} className="h-7 text-xs">
            允许
          </Button>
        </div>
      </div>
    </div>
  );
}
