/**
 * 代理设置（批次 F3-1）：应用级 HTTP 代理三档 off / custom / follow-env。
 * 作用于 Rust 侧请求（WebDAV 同步 / 网络搜索 / MCP stdio 子进程 env 注入等）；
 * 应用级代理即可，无需 TUN。LLM 对话流量走 WebView2，跟随 Windows 系统代理，不受此设置影响。
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Network } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

type ProxyMode = "off" | "custom" | "follow-env";

interface ProxyConfig {
  mode: ProxyMode;
  url: string;
}

interface ProxyTestResult {
  zotero: boolean;
  unpaywall: boolean;
  message: string;
}

const MODE_OPTIONS: Array<{ value: ProxyMode; label: string; desc: string }> = [
  { value: "off", label: "关闭", desc: "直连（遵循系统代理与环境变量）" },
  { value: "custom", label: "自定义", desc: "指定本机代理软件端口（推荐）" },
  { value: "follow-env", label: "跟随环境变量", desc: "读取 HTTP_PROXY / HTTPS_PROXY" },
];

export default function ProxySettings() {
  const [mode, setMode] = useState<ProxyMode>("off");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const config = await invoke<ProxyConfig>("proxy_get_config");
      setMode(config.mode ?? "off");
      setUrl(config.url ?? "");
    } catch (error) {
      console.error("读取代理设置失败:", error);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSave = async () => {
    if (mode === "custom" && !url.trim()) {
      toast.error("自定义模式请填写代理地址");
      return;
    }
    setSaving(true);
    try {
      await invoke("proxy_save_config", { mode, url: url.trim() });
      toast.success("代理设置已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const result = await invoke<ProxyTestResult>("proxy_test");
      if (result.zotero && result.unpaywall) {
        toast.success(result.message);
      } else {
        toast.warning(result.message, { duration: 8000 });
      }
    } catch (error) {
      toast.error(`测试失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6 p-4">
      <div className="space-y-2">
        <h2 className="font-semibold text-lg dark:text-neutral-100">网络代理</h2>
        <p className="text-neutral-600 text-sm dark:text-neutral-400">
          应用级 HTTP 代理，作用于 Rust 侧请求（数据同步、网络搜索、MCP 本地子进程等）。 只需代理软件在运行，无需开启
          TUN 或系统代理模式。
        </p>
      </div>

      <section className="space-y-2">
        <div className="space-y-1.5">
          {MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setMode(option.value)}
              className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                mode === option.value
                  ? "border-neutral-400 bg-muted dark:border-neutral-600"
                  : "border-transparent hover:bg-muted/60"
              }`}
            >
              <span
                className={`size-3 shrink-0 rounded-full border ${
                  mode === option.value
                    ? "border-neutral-700 bg-neutral-700 dark:border-neutral-200 dark:bg-neutral-200"
                    : "border-neutral-400 dark:border-neutral-600"
                }`}
              />
              <span className="min-w-0">
                <span className="block text-neutral-800 text-sm dark:text-neutral-200">{option.label}</span>
                <span className="block text-neutral-500 text-xs dark:text-neutral-500">{option.desc}</span>
              </span>
            </button>
          ))}
        </div>

        {mode === "custom" && (
          <div className="space-y-1.5 pt-1">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://127.0.0.1:7890"
              className="font-mono text-sm"
            />
            <p className="text-neutral-500 text-xs dark:text-neutral-500">
              填写本机代理软件的 HTTP 混合端口（如 Clash 默认 7890）。建议使用 HTTP 端口，不支持 SOCKS。
            </p>
          </div>
        )}

        <div className="flex items-center gap-2 pt-2">
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            保存
          </Button>
          <Button size="sm" variant="outline" onClick={handleTest} disabled={testing}>
            {testing ? <Loader2 className="size-4 animate-spin" /> : <Network className="size-4" />}
            测试代理
          </Button>
        </div>
      </section>

      <section className="space-y-1.5 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
        <h3 className="font-medium text-neutral-700 text-sm dark:text-neutral-300">生效范围说明</h3>
        <ul className="list-disc space-y-1 pl-4 text-neutral-500 text-xs dark:text-neutral-500">
          <li>数据同步（WebDAV）、网络搜索、Agent HTTP 请求：遵循本设置</li>
          <li>MCP stdio 子进程（npx / uvx 等）：自动注入代理环境变量；Node 系 server 需 Node ≥ 22.21 才生效</li>
          <li>localhost / 127.0.0.1 恒不走代理</li>
          <li>LLM 对话与 embedding 流量走 WebView2，跟随 Windows 系统代理，不受本设置影响</li>
        </ul>
      </section>
    </div>
  );
}
