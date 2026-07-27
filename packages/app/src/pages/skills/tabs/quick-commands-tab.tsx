import { ICON_NAMES, getCommandIcon } from "@/components/side-chat/command-icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { type AgentScope, type QuickCommand, useQuickCommandStore } from "@/store/quick-command-store";
import { Eye, EyeOff, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

const SCOPE_LABELS: Record<AgentScope, string> = {
  reader: "阅读助手",
  central: "全局助手",
  both: "两者共享",
};

export default function QuickCommandsTab() {
  const { commands, addCommand, updateCommand, deleteCommand, toggleVisible } = useQuickCommandStore();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingCmd, setEditingCmd] = useState<QuickCommand | null>(null);
  const [label, setLabel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [scope, setScope] = useState<AgentScope>("reader");
  const [icon, setIcon] = useState<string>("Zap");

  const readerCommands = commands
    .filter((c) => c.scope === "reader" || c.scope === "both")
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const centralCommands = commands
    .filter((c) => c.scope === "central" || c.scope === "both")
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const openCreate = () => {
    setEditingCmd(null);
    setLabel("");
    setPrompt("");
    setScope("reader");
    setIcon("Zap");
    setIsDialogOpen(true);
  };

  const openEdit = (cmd: QuickCommand) => {
    setEditingCmd(cmd);
    setLabel(cmd.label);
    setPrompt(cmd.prompt);
    setScope(cmd.scope);
    setIcon(cmd.icon ?? "Zap");
    setIsDialogOpen(true);
  };

  const handleSave = () => {
    if (!label.trim() || !prompt.trim()) return;
    if (editingCmd) {
      updateCommand(editingCmd.id, { label: label.trim(), prompt: prompt.trim(), scope, icon });
    } else {
      addCommand({ label: label.trim(), prompt: prompt.trim(), scope, icon, visible: true });
    }
    setIsDialogOpen(false);
  };

  const renderCommandGroup = (title: string, cmds: QuickCommand[]) => (
    <div className="space-y-2">
      <h3 className="font-medium text-foreground text-sm">{title}</h3>
      {cmds.length === 0 ? (
        <p className="text-muted-foreground text-xs">暂无指令</p>
      ) : (
        <div className="space-y-1">
          {cmds.map((cmd) => {
            const CmdIcon = getCommandIcon(cmd.icon);
            return (
              <div key={cmd.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
                <CmdIcon className="size-3.5 flex-shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <span className="text-foreground text-sm">{cmd.label}</span>
                  <p className="truncate text-muted-foreground text-xs">{cmd.prompt}</p>
                </div>
                {cmd.scope === "both" && (
                  <span className="flex-shrink-0 rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                    共享
                  </span>
                )}
                <Button variant="ghost" size="icon" className="size-7" onClick={() => toggleVisible(cmd.id)}>
                  {cmd.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5 text-muted-foreground" />}
                </Button>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => openEdit(cmd)}>
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-destructive"
                  onClick={() => deleteCommand(cmd.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">自定义聊天界面中显示的快捷指令按钮</p>
        <Button size="sm" variant="outline" onClick={openCreate}>
          <Plus className="size-4" />
          添加指令
        </Button>
      </div>

      {renderCommandGroup("阅读助手（侧边栏）", readerCommands)}
      {renderCommandGroup("全局助手（主页）", centralCommands)}

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{editingCmd ? "编辑快捷指令" : "新建快捷指令"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 px-3 py-4">
            <div className="space-y-2">
              <Label>显示名称</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="如：总结本章" />
            </div>
            <div className="space-y-2">
              <Label>发送的提示词</Label>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="点击后实际发送给 AI 的内容"
                className="h-24 resize-none"
              />
            </div>
            <div className="space-y-2">
              <Label>生效范围</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as AgentScope)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="reader">阅读助手</SelectItem>
                  <SelectItem value="central">全局助手</SelectItem>
                  <SelectItem value="both">两者共享</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>图标</Label>
              <div className="flex max-h-44 flex-wrap gap-1 overflow-y-auto pr-1">
                {ICON_NAMES.map((name) => {
                  const IconComp = getCommandIcon(name);
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setIcon(name)}
                      className={cn(
                        "flex size-8 items-center justify-center rounded-md border transition-colors",
                        icon === name
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:bg-muted",
                      )}
                    >
                      <IconComp className="size-4" />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setIsDialogOpen(false)}>
              取消
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!label.trim() || !prompt.trim()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
