import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RETRIEVAL_SCOPE_OPTIONS, type RetrievalScopeRole, isRetrievalScope } from "@/constants/retrieval-scope";
import { normalizeDocumentToolMode, useAgentSettingsStore } from "@/store/agent-settings-store";
import { useRetrievalScopeFor, useRetrievalScopeStore } from "@/store/retrieval-scope-store";

interface RetrievalScopeSelectProps {
  role: RetrievalScopeRole;
  /** reader 传 bookId，paper 传 paperId；缺省不渲染（尚未打开文档） */
  docId?: string;
  className?: string;
}

/**
 * 检索范围下拉（阅读助手：本书 / 图书馆 / 图书馆+论文库；论文助手：本篇 / 论文库 / 论文库+图书馆）。
 * - 按每本书/每篇论文持久化，reader 缺省本书、paper 缺省论文库；
 * - 旧版文档工具模式下隐藏：旧工具集无法完整兑现三档语义，避免给出误导性的范围承诺。
 * 全局助手不渲染本组件（无下拉，恒为全部/全能）。
 */
export function RetrievalScopeSelect({ role, docId, className }: RetrievalScopeSelectProps) {
  // 订阅设置变化；同时尊重评测/调试用的 window 覆盖（mode.ts 的 __SAGEREAD_DOC_TOOL_MODE__）
  const documentToolMode = useAgentSettingsStore((state) => {
    const override = typeof window !== "undefined" ? window.__SAGEREAD_DOC_TOOL_MODE__ : undefined;
    return override !== undefined ? normalizeDocumentToolMode(override) : state.documentToolMode;
  });
  const scope = useRetrievalScopeFor(role, docId);
  const setScope = useRetrievalScopeStore((state) => state.setScope);

  if (documentToolMode === "legacy" || !docId) return null;

  return (
    <Select
      value={scope}
      onValueChange={(value) => {
        if (isRetrievalScope(value)) setScope(role, docId, value);
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <SelectTrigger className={`h-7 w-[8.5rem] min-w-0 shrink text-xs ${className ?? ""}`} aria-label="检索范围">
            <SelectValue />
          </SelectTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">检索与直读范围（用户划定，AI 不能越界）</TooltipContent>
      </Tooltip>
      <SelectContent>
        {RETRIEVAL_SCOPE_OPTIONS[role].map((option) => (
          <SelectItem key={option.value} value={option.value} title={option.description}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
