import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type AgentSafetyMode, type AgentWorkspaceScope, useAgentSettingsStore } from "@/store/agent-settings-store";
import { appDataDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

const MODE_OPTIONS: { value: AgentSafetyMode; label: string; desc: string }[] = [
  {
    value: "strict",
    label: "严格",
    desc: "工作区内读写静默执行；界外读取/写入、命令执行均逐次弹确认卡。",
  },
  {
    value: "relaxed",
    label: "宽松",
    desc: "界外读取也静默执行；界外写入与命令执行仍逐次弹确认卡。",
  },
  {
    value: "full",
    label: "完全访问",
    desc: "读写与命令执行全部静默（网络外发仍确认）。注意防范提示注入风险。",
  },
];

const SCOPE_OPTIONS: { scope: AgentWorkspaceScope; label: string }[] = [
  { scope: "central", label: "全局助手" },
  { scope: "reader", label: "阅读助手" },
  { scope: "paper", label: "论文助手" },
];

/**
 * Agent 设置（P1）：安全模式三档（对全局/阅读/论文三个助手一致生效）+ 工作区根。
 * 工作区模型：共享单根为默认，可按助手覆盖（留空跟随共享根）；记忆随根走。
 * 界内界外的路径判定在原生侧强制（含符号链接解析），不依赖模型自觉。
 */
export default function AgentSettings() {
  const { safetyMode, workspaceRoot, perAgentRoots, setSafetyMode, setWorkspaceRoot, setPerAgentRoot } =
    useAgentSettingsStore();
  const [defaultRoot, setDefaultRoot] = useState("");
  const [auditPath, setAuditPath] = useState("");

  useEffect(() => {
    appDataDir().then((dir) => {
      const base = dir.replace(/[\\/]+$/, "");
      setDefaultRoot(`${base}/agent-workspace`);
      setAuditPath(`${base}/agent-audit/commands.jsonl`);
    });
  }, []);

  const currentMode = MODE_OPTIONS.find((m) => m.value === safetyMode) ?? MODE_OPTIONS[0];

  const handleBrowse = async (apply: (dir: string) => void) => {
    const dir = await open({ directory: true, multiple: false, title: "选择 Agent 工作区目录" });
    if (typeof dir === "string" && dir.trim()) {
      apply(dir);
    }
  };

  return (
    <div className="space-y-6 p-4">
      <div>
        <h2 className="font-medium text-lg dark:text-neutral-100">Agent</h2>
        <p className="mt-1 text-neutral-500 text-sm dark:text-neutral-400">
          三个助手（全局/阅读/论文）的写文件 /
          执行命令能力与安全策略。界内界外的路径判定在原生侧强制（含符号链接解析），不依赖模型自觉。
        </p>
      </div>

      {/* 安全模式 */}
      <section className="rounded-lg bg-muted/80 p-4">
        <div className="flex items-center justify-between gap-4">
          <Label className="text-sm">安全模式</Label>
          <Select value={safetyMode} onValueChange={(v) => setSafetyMode(v as AgentSafetyMode)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODE_OPTIONS.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="mt-2 text-neutral-500 text-xs dark:text-neutral-400">{currentMode.desc}</p>
        <p className="mt-1 text-neutral-500 text-xs dark:text-neutral-400">
          对全局助手与侧边栏的阅读/论文助手一致生效。确认卡可勾选"本次会话不再询问"（重启应用后失效）。命令执行在任何模式下都会记录审计日志：
          <code className="mx-1 break-all rounded bg-background px-1 dark:bg-neutral-700">{auditPath || "…"}</code>
        </p>
      </section>

      {/* 共享工作区根 */}
      <section className="rounded-lg bg-muted/80 p-4">
        <Label className="text-sm">工作区根目录（共享）</Label>
        <p className="mt-1 text-neutral-500 text-xs dark:text-neutral-400">
          三个助手默认共用此根与其中的 memory.md（共享记忆）。可指向 Obsidian
          库或任意项目文件夹，产物直接落入你的目录结构。
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Input
            type="text"
            value={workspaceRoot ?? ""}
            onChange={(e) => setWorkspaceRoot(e.target.value.trim() || null)}
            placeholder={defaultRoot || "默认工作区"}
            className="h-8 flex-1"
          />
          <button
            type="button"
            onClick={() => handleBrowse((dir) => setWorkspaceRoot(dir))}
            className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-md border border-neutral-200 px-2 text-xs hover:bg-accent dark:border-neutral-700"
          >
            <FolderOpen className="size-3.5" />
            浏览…
          </button>
          {workspaceRoot !== null && (
            <button
              type="button"
              onClick={() => setWorkspaceRoot(null)}
              className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-md border border-neutral-200 px-2 text-xs hover:bg-accent dark:border-neutral-700"
            >
              <RotateCcw className="size-3.5" />
              恢复默认
            </button>
          )}
        </div>
        <p className="mt-2 break-all text-neutral-500 text-xs dark:text-neutral-400">
          当前生效：{workspaceRoot || defaultRoot || "…"}
        </p>
      </section>

      {/* 按助手覆盖 */}
      <section className="rounded-lg bg-muted/80 p-4">
        <Label className="text-sm">按助手覆盖（可选）</Label>
        <p className="mt-1 text-neutral-500 text-xs dark:text-neutral-400">
          为某个助手单独指定工作区根，留空则跟随共享根。覆盖了根的助手拥有独立的 memory.md（记忆随根走）。
          例如：把阅读助手指向 Obsidian 库，笔记落盘进库；全局助手留在默认区跑脚本，互不污染。
        </p>
        <div className="mt-3 space-y-2">
          {SCOPE_OPTIONS.map(({ scope, label }) => (
            <div key={scope} className="flex items-center gap-2">
              <span className="w-16 flex-shrink-0 text-neutral-600 text-xs dark:text-neutral-300">{label}</span>
              <Input
                type="text"
                value={perAgentRoots[scope] ?? ""}
                onChange={(e) => setPerAgentRoot(scope, e.target.value.trim() || null)}
                placeholder="跟随共享根"
                className="h-8 flex-1"
              />
              <button
                type="button"
                onClick={() => handleBrowse((dir) => setPerAgentRoot(scope, dir))}
                className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-md border border-neutral-200 px-2 text-xs hover:bg-accent dark:border-neutral-700"
              >
                <FolderOpen className="size-3.5" />
              </button>
              {perAgentRoots[scope] && (
                <button
                  type="button"
                  onClick={() => setPerAgentRoot(scope, null)}
                  title="清除覆盖，跟随共享根"
                  className="inline-flex h-8 cursor-pointer items-center rounded-md border border-neutral-200 px-2 text-xs hover:bg-accent dark:border-neutral-700"
                >
                  <RotateCcw className="size-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
