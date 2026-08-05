import { useAgentSettingsStore } from "@/store/agent-settings-store";
import { appDataDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * P1 central 输入区工作区指示器：显示全局助手当前生效的工作区根（末段名），点击切换。
 * 共享根 + 按助手覆盖（2026-08-05 拍板）：此处切换的是"全局助手"的覆盖根；
 * 共享根与其余助手的覆盖在 设置 → Agent 中管理。
 */
export function WorkspaceChip() {
  const { perAgentRoots, setPerAgentRoot } = useAgentSettingsStore();
  const [displayRoot, setDisplayRoot] = useState("");

  // 生效根 = central 覆盖 ?? 共享根 ?? 默认（display 用；解析逻辑与工具侧一致）
  const workspaceRoot = useAgentSettingsStore((s) => s.workspaceRoot);
  useEffect(() => {
    const override = perAgentRoots.central || workspaceRoot;
    if (override) {
      setDisplayRoot(override);
    } else {
      appDataDir().then((dir) => {
        setDisplayRoot(`${dir.replace(/[\\/]+$/, "")}/agent-workspace`);
      });
    }
  }, [perAgentRoots.central, workspaceRoot]);

  const shortName = displayRoot ? (displayRoot.split(/[\\/]/).filter(Boolean).pop() ?? displayRoot) : "…";

  const handleClick = async () => {
    const dir = await open({
      directory: true,
      multiple: false,
      title: "选择全局助手的工作区目录",
      defaultPath: displayRoot || undefined,
    });
    if (typeof dir === "string" && dir.trim()) {
      setPerAgentRoot("central", dir);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={`Agent 工作区（全局助手）：${displayRoot || "…"}（点击切换；共享根与各助手覆盖见 设置 → Agent）`}
      className="flex h-7 cursor-pointer items-center gap-1 rounded-md bg-muted px-2 text-neutral-600 text-xs hover:bg-muted/70 dark:text-neutral-300"
    >
      <FolderOpen className="size-3.5 flex-shrink-0" />
      <span className="max-w-32 truncate">{shortName}</span>
    </button>
  );
}
