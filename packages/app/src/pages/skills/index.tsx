import { cn } from "@/lib/utils";
import { BookOpen, Brain, Plug, Zap } from "lucide-react";
import { useState } from "react";
import McpTab from "./tabs/mcp-tab";
import PromptsTab from "./tabs/prompts-tab";
import QuickCommandsTab from "./tabs/quick-commands-tab";
import SkillsTab from "./tabs/skills-tab";

const TABS = [
  { id: "commands", label: "快捷指令", icon: Zap },
  { id: "prompts", label: "提示词", icon: Brain },
  { id: "skills", label: "技能库", icon: BookOpen },
  { id: "mcp", label: "MCP", icon: Plug },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function AIHubPage() {
  const [activeTab, setActiveTab] = useState<TabId>("commands");

  return (
    <div className="flex h-full flex-col p-3">
      <div className="mb-4">
        <h1 className="font-bold text-3xl">AI 中心</h1>
        <p className="text-muted-foreground">管理快捷指令、提示词、技能和 MCP 服务器</p>
      </div>

      <div className="mb-4 flex gap-1 rounded-lg border border-border p-1">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
              activeTab === id
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {activeTab === "commands" && <QuickCommandsTab />}
        {activeTab === "prompts" && <PromptsTab />}
        {activeTab === "skills" && <SkillsTab />}
        {activeTab === "mcp" && <McpTab />}
      </div>
    </div>
  );
}
