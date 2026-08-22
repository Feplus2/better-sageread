import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MarketInstallPrefill } from "@/services/mcp-registry-service";
import { secretListUser } from "@/services/secret-service";
import { SKILL_SCOPE_LABELS } from "@/services/skill-service";
import { type McpServer, useMcpStore } from "@/store/mcp-store";
import type { AgentScope } from "@/store/quick-command-store";
import { KeyRound, Pencil, Plug, Plus, Server, ShoppingBag, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ScopeCheckboxes } from "../components/scope-checkboxes";
import { McpMarketDialog } from "./mcp-market-dialog";

const ALL_SCOPES: AgentScope[] = ["central", "reader", "paper"];

type KvRow = { key: string; value: string };

function recordToRows(rec?: Record<string, string>): KvRow[] {
  return Object.entries(rec ?? {}).map(([key, value]) => ({ key, value }));
}

function rowsToRecord(rows: KvRow[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (row.key.trim()) out[row.key.trim()] = row.value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 密钥占位符插入按钮：弹出密钥保管箱已有秘钥列表，点选填入 {{secret:NAME}}；底部可新建占位符 */
function SecretInsertButton({ onInsert }: { onInsert: (placeholder: string) => void }) {
  const [open, setOpen] = useState(false);
  const [secrets, setSecrets] = useState<string[] | null>(null);
  const [newName, setNewName] = useState("");
  // 保管箱名称约束（secret_user_set 后端口径）
  const newNameValid = /^[A-Za-z0-9_-]{1,64}$/.test(newName.trim());

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    secretListUser()
      .then((names) => {
        if (!cancelled) setSecrets(names);
      })
      .catch(() => {
        if (!cancelled) setSecrets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const insert = (name: string) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) return;
    onInsert(`{{secret:${name}}}`);
    setNewName("");
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="size-7 flex-shrink-0">
              <KeyRound className="size-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">插入密钥保管箱引用（真值存保管箱，不落配置）</TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="end" className="w-64 p-2">
        {secrets === null ? (
          <p className="px-1 py-2 text-muted-foreground text-xs">加载中…</p>
        ) : secrets.length === 0 ? (
          <p className="px-1 py-2 text-muted-foreground text-xs">保管箱暂无密钥，可先在 设置 → 密钥保管箱 添加</p>
        ) : (
          <div className="max-h-48 overflow-auto">
            {secrets.map((name) => (
              <button
                key={name}
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-xs hover:bg-accent"
                onClick={() => insert(name)}
              >
                <KeyRound className="size-3 flex-shrink-0 text-muted-foreground" />
                {name}
              </button>
            ))}
          </div>
        )}
        <div className="mt-2 flex items-center gap-1.5 border-t pt-2">
          <Input
            className="h-7 flex-1 font-mono text-xs"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="新建占位符名称"
            onKeyDown={(e) => {
              if (e.key === "Enter" && newNameValid) insert(newName.trim());
            }}
          />
          <Button
            type="button"
            size="sm"
            className="h-7 text-xs"
            disabled={!newNameValid}
            onClick={() => insert(newName.trim())}
          >
            插入
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** 键值对编辑器：env（stdio）与 headers（远程）共用；secretHelper 为 headers 提供占位符插入 */
function KvEditor({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  secretHelper,
}: {
  rows: KvRow[];
  onChange: (rows: KvRow[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  secretHelper?: boolean;
}) {
  const update = (index: number, patch: Partial<KvRow>) => {
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };
  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            className="flex-1"
            value={row.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder={keyPlaceholder}
          />
          <Input
            className="flex-[2]"
            value={row.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder={valuePlaceholder}
          />
          {secretHelper && (
            <SecretInsertButton
              onInsert={(placeholder) => update(i, { value: row.value ? `${row.value}${placeholder}` : placeholder })}
            />
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 flex-shrink-0"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, { key: "", value: "" }])}>
        <Plus className="size-3.5" />
        添加一行
      </Button>
    </div>
  );
}

export default function McpTab() {
  const { servers, addServer, updateServer, removeServer, toggleEnabled } = useMcpStore();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServer | null>(null);
  const [marketOpen, setMarketOpen] = useState(false);
  /** 市场安装来源标记（保存时写 source/registryName） */
  const [registryName, setRegistryName] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "sse" | "stdio">("http");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [url, setUrl] = useState("");
  const [headerRows, setHeaderRows] = useState<KvRow[]>([]);
  const [envRows, setEnvRows] = useState<KvRow[]>([]);
  const [scope, setScope] = useState<AgentScope[]>(ALL_SCOPES);

  const openCreate = () => {
    setEditingServer(null);
    setRegistryName(null);
    setName("");
    setTransport("http");
    setCommand("");
    setArgsText("");
    setUrl("");
    setHeaderRows([]);
    setEnvRows([]);
    setScope(ALL_SCOPES);
    setIsDialogOpen(true);
  };

  /** 市场一键安装：预填编辑表单，用户确认/补 env 后落库 */
  const handleMarketInstall = (prefill: MarketInstallPrefill, registry: string) => {
    setEditingServer(null);
    setRegistryName(registry);
    setName(prefill.name);
    setTransport(prefill.transport);
    setCommand(prefill.command ?? "");
    setArgsText(prefill.args?.join("\n") ?? "");
    setUrl(prefill.url ?? "");
    setHeaderRows(recordToRows(prefill.headers));
    setEnvRows(recordToRows(prefill.env));
    setScope(ALL_SCOPES);
    setIsDialogOpen(true);
  };

  const openEdit = (server: McpServer) => {
    setEditingServer(server);
    setRegistryName(server.registryName ?? null);
    setName(server.name);
    setTransport(server.transport);
    setCommand(server.command ?? "");
    setArgsText(server.args?.join("\n") ?? "");
    setUrl(server.url ?? "");
    setHeaderRows(recordToRows(server.headers));
    setEnvRows(recordToRows(server.env));
    setScope(server.scope);
    setIsDialogOpen(true);
  };

  const remote = transport === "http" || transport === "sse";
  const canSave =
    name.trim().length > 0 && scope.length > 0 && (remote ? url.trim().length > 0 : command.trim().length > 0);

  const handleSave = () => {
    if (!canSave) return;
    const args = argsText
      .split("\n")
      .map((a) => a.trim())
      .filter(Boolean);
    const data = {
      name: name.trim(),
      transport,
      command: transport === "stdio" ? command.trim() : undefined,
      args: transport === "stdio" && args.length > 0 ? args : undefined,
      url: remote ? url.trim() : undefined,
      headers: remote ? rowsToRecord(headerRows) : undefined,
      env: transport === "stdio" ? rowsToRecord(envRows) : undefined,
      scope,
      enabled: editingServer?.enabled ?? true,
      source: registryName ? "registry" : ("manual" as const),
      registryName: registryName ?? undefined,
    };

    if (editingServer) {
      updateServer(editingServer.id, data as Partial<Omit<McpServer, "id">>);
    } else {
      addServer(data as Omit<McpServer, "id">);
    }
    setIsDialogOpen(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          MCP 协议集成 — 远程传输（Streamable HTTP / SSE）与 stdio 本地命令均已可用
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setMarketOpen(true)}>
            <ShoppingBag className="size-4" />
            浏览市场
          </Button>
          <Button size="sm" variant="outline" onClick={openCreate}>
            <Plus className="size-4" />
            添加服务器
          </Button>
        </div>
      </div>

      {/* D8 预算守门的事前提示：连接器过多会显著增加工具面，聊天请求会自动切换"目录牌模式"
          （按需取说明书，不崩溃但首次调用多一步）；此处提示引导收敛生效范围 */}
      {servers.length > 10 && (
        <div className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-700 text-xs dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
          已挂载 {servers.length} 个连接器——工具池较大时模型选工具的准确率会下降，聊天将自动启用「目录牌
          按需加载」模式（调用前先查说明书）。建议在各项连接器里只勾选真正需要的助手生效范围。
        </div>
      )}

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
                  {server.transport === "stdio" && (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 text-xs dark:bg-emerald-900/40 dark:text-emerald-400">
                      本地进程
                    </span>
                  )}
                  {server.scope.map((s) => (
                    <span key={s} className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                      {SKILL_SCOPE_LABELS[s]}
                    </span>
                  ))}
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
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{editingServer ? "编辑 MCP 服务器" : "添加 MCP 服务器"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 px-3 py-4">
            <div className="space-y-2">
              <Label>名称</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：ima-knowledge-base" />
            </div>
            <div className="space-y-2">
              <Label>传输方式</Label>
              <Select value={transport} onValueChange={(v) => setTransport(v as "http" | "sse" | "stdio")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">HTTP（Streamable HTTP，推荐）</SelectItem>
                  <SelectItem value="sse">SSE（旧版远程）</SelectItem>
                  <SelectItem value="stdio">stdio（本地命令）</SelectItem>
                </SelectContent>
              </Select>
              {transport === "stdio" && (
                <p className="text-muted-foreground text-xs">
                  运行时由 Rust 侧 spawn 本地子进程（npx / uvx 等）；env 中的密钥一律用
                  {" {{secret:NAME}} "}引用，真值不进前端
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>生效范围</Label>
              <ScopeCheckboxes value={scope} onChange={setScope} />
            </div>
            {transport === "stdio" ? (
              <>
                <div className="space-y-2">
                  <Label>命令</Label>
                  <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="如：npx" />
                </div>
                <div className="space-y-2">
                  <Label>参数（每行一个）</Label>
                  <Textarea
                    value={argsText}
                    onChange={(e) => setArgsText(e.target.value)}
                    placeholder={"如：\n-y\n@modelcontextprotocol/server-filesystem"}
                    rows={3}
                  />
                </div>
                <div className="space-y-2">
                  <Label>环境变量</Label>
                  <KvEditor
                    rows={envRows}
                    onChange={setEnvRows}
                    keyPlaceholder="变量名（如 API_KEY）"
                    valuePlaceholder="值（密钥建议写 {{secret:NAME}}）"
                    secretHelper
                  />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <Label>URL</Label>
                  <Input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder={transport === "http" ? "如：https://example.com/mcp" : "如：https://example.com/sse"}
                  />
                </div>
                <div className="space-y-2">
                  <Label>请求头（可选，如 Authorization）</Label>
                  <KvEditor
                    rows={headerRows}
                    onChange={setHeaderRows}
                    keyPlaceholder="头名（如 Authorization）"
                    valuePlaceholder="值（密钥建议写 {{secret:NAME}}）"
                    secretHelper
                  />
                  <p className="text-muted-foreground text-xs">
                    密钥真值请存入 设置 → 密钥保管箱，此处只写 {"{{secret:NAME}}"} 占位符
                  </p>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setIsDialogOpen(false)}>
              取消
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!canSave}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <McpMarketDialog open={marketOpen} onOpenChange={setMarketOpen} onInstall={handleMarketInstall} />
    </div>
  );
}
