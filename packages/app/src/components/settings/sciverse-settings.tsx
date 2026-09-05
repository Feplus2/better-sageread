import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSciverseStore } from "@/store/sciverse-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink } from "lucide-react";
import SecretInput from "./secret-input";

/**
 * 科研搜索设置（Sciverse）：与「网络搜索」并列独立的一栏。
 * 网络搜索（webSearch）管通用网页/实时资讯；科研搜索（sciverseSearch）管学术证据检索——
 * 两者可同时开启，Agent 按问题类型自动路由。
 */
export default function SciverseSettings() {
  const { enabled, token, setEnabled, setToken } = useSciverseStore();
  const hasToken = token.trim().length > 0;

  return (
    <div className="space-y-6 p-4">
      <div>
        <h2 className="font-medium text-lg dark:text-neutral-100">科研搜索</h2>
        <p className="mt-1 text-neutral-500 text-sm dark:text-neutral-400">
          配置 Sciverse 学术证据检索（OpenDataLab 科学证据数据层）。与「网络搜索」是叠加关系： 学术/科研类问题 Agent
          会优先用科研搜索直接拿论文原文证据，通用网页与资讯仍走网络搜索。
        </p>
      </div>

      <section className="rounded-lg bg-muted/80 p-4">
        {/* 标题行：名称 + 启用开关 */}
        <div className="flex items-center justify-between">
          <span className="font-medium text-sm dark:text-neutral-200">Sciverse（科研证据引擎）</span>
          {!hasToken ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Switch checked={enabled} onCheckedChange={setEnabled} disabled />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">请先填写 API Token</TooltipContent>
            </Tooltip>
          ) : (
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          )}
        </div>
        <p className="mt-1.5 text-neutral-500 text-xs dark:text-neutral-400">
          覆盖 4.5 亿+ 知识记录与 3000 万+ AI-Ready
          论文全文。返回带出处坐标（标题/页码/原文偏移）的证据片段，回答可引用追溯。免费 starter
          额度，超额会限流（429）。
        </p>

        {/* 配置输入 */}
        <div className="mt-3 space-y-2">
          <div className="space-y-1.5">
            <Label className="text-xs">API Token</Label>
            {/* key 由 keyring 保管（account: sciverse:token），不回显真值 */}
            <SecretInput
              category="sciverse"
              secretKey="token"
              placeholder="sv-..."
              className="h-8"
              onSaved={(value) => setToken(value)}
              onCleared={() => {
                setToken("");
                setEnabled(false);
              }}
            />
          </div>

          <button
            type="button"
            onClick={() => openUrl("https://sciverse.space")}
            className="inline-flex cursor-pointer items-center gap-1 text-primary text-xs hover:underline"
          >
            <ExternalLink className="size-3" />
            前往 sciverse.space 控制台免费申请 Token
          </button>
        </div>
      </section>

      <section className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-700">
        <p className="text-neutral-500 text-xs dark:text-neutral-400">
          启用后三个 AI 助手（全局/阅读/论文）都会获得 sciverseSearch 工具。约四分之一的论文有 AI-Ready
          全文证据，未覆盖到的记录只回元数据；需要发现、下载、导入文献时请配合 Zotero 类 MCP 工具使用。
        </p>
      </section>
    </div>
  );
}
