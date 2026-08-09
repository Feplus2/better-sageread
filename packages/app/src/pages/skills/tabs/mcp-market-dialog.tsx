/**
 * MCP 市场对话框（批次 C1）：对接官方 Registry 的搜索/分页/详情/一键安装。
 * 安装 = 将条目映射为预填配置交回 mcp-tab 编辑表单，用户确认/补 env 后落库。
 */
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  type MarketInstallPrefill,
  type RegistryEntry,
  buildInstallPrefill,
  searchRegistryServers,
} from "@/services/mcp-registry-service";
import { ArrowLeft, Loader2, Search, Star } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

interface McpMarketDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: (prefill: MarketInstallPrefill, registryName: string) => void;
}

export function McpMarketDialog({ open, onOpenChange, onInstall }: McpMarketDialogProps) {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RegistryEntry | null>(null);

  const doSearch = useCallback(async (search: string, cursor?: string | null, append = false) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const result = await searchRegistryServers(search, cursor);
      setEntries((prev) => (append ? [...prev, ...result.entries] : result.entries));
      setNextCursor(result.nextCursor);
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  // 打开时自动加载首页
  useEffect(() => {
    if (open && !loaded) {
      void doSearch("");
    }
    if (!open) setSelected(null);
  }, [open, loaded, doSearch]);

  const handleInstall = (entry: RegistryEntry) => {
    const prefill = buildInstallPrefill(entry);
    if (prefill.unsupported) {
      toast.warning(prefill.unsupported);
      return;
    }
    onInstall(prefill, entry.server.name);
    onOpenChange(false);
  };

  const displayName = (entry: RegistryEntry) =>
    entry.server.title || entry.server.name.split("/").pop() || entry.server.name;
  const isOfficialActive = (entry: RegistryEntry) =>
    entry._meta?.["io.modelcontextprotocol.registry/official"]?.status === "active" &&
    entry._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest === true;
  // oci 分发的 server 暂不支持一键安装（C1 明确不做），安装按钮置灰
  const isOciEntry = (entry: RegistryEntry) =>
    (entry.server.remotes?.length ?? 0) === 0 && entry.server.packages?.[0]?.registryType === "oci";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle>{selected ? "MCP 详情" : "MCP 市场"}</DialogTitle>
        </DialogHeader>

        {selected ? (
          /* ========== 详情视图 ========== */
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-4">
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setSelected(null)}>
              <ArrowLeft className="size-4" />
              返回列表
            </Button>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">{displayName(selected)}</h3>
                {selected.server.version && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                    v{selected.server.version}
                  </span>
                )}
                {isOfficialActive(selected) && (
                  <span className="inline-flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 text-xs dark:bg-amber-900/40 dark:text-amber-400">
                    <Star className="size-3" />
                    官方
                  </span>
                )}
              </div>
              <p className="mt-1 text-muted-foreground text-xs">{selected.server.name}</p>
            </div>
            {selected.server.description && <p className="text-sm">{selected.server.description}</p>}

            {/* 传输/安装方式说明 */}
            <div className="space-y-1 text-muted-foreground text-xs">
              {selected.server.remotes?.map((r, i) => (
                <p key={i}>
                  远程：{r.type} · {r.url}
                </p>
              ))}
              {selected.server.packages?.map((p, i) => (
                <p key={i}>
                  安装包：{p.registryType} · {p.identifier}
                  {p.version ? `@${p.version}` : ""}
                </p>
              ))}
            </div>

            {/* 环境变量清单 */}
            {(selected.server.packages?.[0]?.environmentVariables?.length ?? 0) > 0 && (
              <div className="space-y-1.5">
                <p className="font-medium text-sm">需要的环境变量</p>
                <div className="space-y-1">
                  {selected.server.packages?.[0]?.environmentVariables?.map((v) => (
                    <div key={v.name} className="rounded border border-border px-2 py-1.5 text-xs">
                      <span className="font-mono">
                        {v.name}
                        {v.isRequired && <span className="text-destructive"> *</span>}
                        {v.isSecret && (
                          <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                            密钥
                          </span>
                        )}
                      </span>
                      {v.description && <p className="text-muted-foreground">{v.description}</p>}
                    </div>
                  ))}
                  <p className="text-muted-foreground text-xs">
                    标「密钥」的变量安装时自动填 {"{{secret:NAME}}"} 占位，真值请到 设置 → 密钥保管箱 补齐
                  </p>
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              {isOciEntry(selected) && <span className="text-muted-foreground text-xs">暂不支持 OCI 安装</span>}
              <Button size="sm" disabled={isOciEntry(selected)} onClick={() => handleInstall(selected)}>
                安装（打开预填表单）
              </Button>
            </div>
          </div>
        ) : (
          /* ========== 列表视图 ========== */
          <>
            <form
              className="flex gap-2 px-3"
              onSubmit={(e) => {
                e.preventDefault();
                void doSearch(query);
              }}
            >
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索 MCP 服务器，如 github、notion…"
              />
              <Button type="submit" size="sm" disabled={loading}>
                <Search className="size-4" />
                搜索
              </Button>
            </form>

            <div className="min-h-0 flex-1 overflow-y-auto px-3">
              {loading ? (
                <div className="flex h-40 items-center justify-center">
                  <Loader2 className="size-6 animate-spin text-muted-foreground" />
                </div>
              ) : error ? (
                <div className="flex h-40 flex-col items-center justify-center gap-2 text-sm">
                  <p className="text-destructive">{error}</p>
                  <Button variant="outline" size="sm" onClick={() => void doSearch(query)}>
                    重试
                  </Button>
                </div>
              ) : entries.length === 0 && loaded ? (
                <p className="py-10 text-center text-muted-foreground text-sm">没有匹配的服务器</p>
              ) : (
                <div className="space-y-2 py-2">
                  {entries.map((entry) => (
                    <button
                      type="button"
                      key={entry.server.name}
                      className="w-full rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-accent"
                      onClick={() => setSelected(entry)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{displayName(entry)}</span>
                        {entry.server.version && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                            v{entry.server.version}
                          </span>
                        )}
                        {isOfficialActive(entry) && (
                          <span className="inline-flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 text-xs dark:bg-amber-900/40 dark:text-amber-400">
                            <Star className="size-3" />
                            官方
                          </span>
                        )}
                        {(entry.server.remotes?.length ?? 0) > 0 ? (
                          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 text-xs dark:bg-emerald-900/40 dark:text-emerald-400">
                            远程
                          </span>
                        ) : (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                            本地（预配置）
                          </span>
                        )}
                      </div>
                      {entry.server.description && (
                        <p className="mt-1 line-clamp-2 text-muted-foreground text-xs">{entry.server.description}</p>
                      )}
                    </button>
                  ))}
                  {nextCursor && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      disabled={loadingMore}
                      onClick={() => void doSearch(query, nextCursor, true)}
                    >
                      {loadingMore ? <Loader2 className="size-4 animate-spin" /> : "加载更多"}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
