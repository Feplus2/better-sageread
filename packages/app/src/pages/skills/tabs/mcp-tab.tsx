import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { type McpServer, useMcpStore } from "@/store/mcp-store";
import type { AgentScope } from "@/store/quick-command-store";
import { Pencil, Plug, Plus, Server, Trash2 } from "lucide-react";
import { useState } from "react";

const SCOPE_LABELS: Record<AgentScope, string> = {
  reader: "阅读助手",
  central: "中央 Agent",
  both: "共享",
};

export default function McpTab() {
  const { servers, addServer, updateServer, removeServer, toggleEnabled } = useMcpStore();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServer | null>(null);

  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "sse">("stdio");
  const [command, setCommand] = useState("");
  const [argsStr, setArgsStr] = useState("");
  const [url, setUrl] = useState("");
  const [scope, setScope] = useState<AgentScope>("both");

  const openCreate = () => {
    setEditingServer(null);
    setName("");
    setTransport("stdio");
    setCommand("");
    setArgsStr("");
    setUrl("");
    setScope("both");
    setIsDialogOpen(true);
  };

  const openEdit = (server: McpServer) => {
    setEditingServer(server);
    setName(server.name);
    setTransport(server.transport);
    setCommand(server.command ?? "");
    setArgsStr(server.args?.join(", ") ?? "");
    setUrl(server.url ?? "");
    setScope(server.scope);
    setIsDialogOpen(true);
  };

  const handleSave = () => {
    if (!name.trim()) return;
    const data = {
      name: name.trim(),
      transport,
      command: transport === "stdio" ? command.trim() : undefined,
      args: transport === "stdio" && argsStr.trim() ? argsStr.split(",").map((a) => a.trim()) : undefined,
      url: transport === "sse" ? url.trim() : undefined,
      scope,
      enabled: editingServer?.enabled ?? true,
    };

    if (editingServer) {
      updateServer(editingServer.id, data);
    } else {
      addServer(data);
    }
    setIsDialogOpen(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">MCP 协议集成即将推出，当前可预先配置服务器</p>
        <Button size="sm" variant="outline" onClick={openCreate}>
          <Plus className="size-4" />
          添加服务器
        </Button>
      </div>

      {servers.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center gap-3">
          <Server className="size-8 text-muted-foreground" />
          <p className="text-muted-foreground text-sm">尚未配置 MCP 服务器</p>
        </div>
      ) : (
        <div className="space-y-2">
          {servers.map((server) => (
            <div key={server.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
              <Plug className="size-4 flex-shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-foreground text-sm">{server.name}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                    {server.transport.toUpperCase()}
                  </span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                    {SCOPE_LABELS[server.scope]}
                  </span>
                </div>
                <p className="truncate text-muted-foreground text-xs">
                  {server.transport === "stdio" ? server.command : server.url}
                </p>
              </div>
              <Switch checked={server.enabled} onCheckedChange={() => toggleEnabled(server.id)} />
              <Button variant="ghost" size="icon" className="size-7" onClick={() => openEdit(server)}>
                <Pencil className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-destructive"
                onClick={() => removeServer(server.id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{editingServer ? "编辑 MCP 服务器" : "添加 MCP 服务器"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 px-3 py-4">
            <div className="space-y-2">
              <Label>名称</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：ima-knowledge-base" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>传输方式</Label>
                <Select value={transport} onValueChange={(v) => setTransport(v as "stdio" | "sse")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stdio">stdio（本地命令）</SelectItem>
                    <SelectItem value="sse">SSE（远程 URL）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>生效范围</Label>
                <Select value={scope} onValueChange={(v) => setScope(v as AgentScope)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="reader">阅读助手</SelectItem>
                    <SelectItem value="central">中央 Agent</SelectItem>
                    <SelectItem value="both">两者共享</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {transport === "stdio" ? (
              <>
                <div className="space-y-2">
                  <Label>命令</Label>
                  <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="如：npx" />
                </div>
                <div className="space-y-2">
                  <Label>参数（逗号分隔）</Label>
                  <Input
                    value={argsStr}
                    onChange={(e) => setArgsStr(e.target.value)}
                    placeholder="如：-y, @modelcontextprotocol/server-filesystem"
                  />
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <Label>URL</Label>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="如：http://localhost:3001/sse"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setIsDialogOpen(false)}>
              取消
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!name.trim()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
