/**
 * MCP 官方 Registry 客户端（批次 C1）
 *
 * 数据源：GET https://registry.modelcontextprotocol.io/v0/servers
 * 请求走 @tauri-apps/plugin-http 的 fetch（Rust 侧出网，绕 CORS）。
 *
 * 实际响应结构（2026-08 实测，与早期文档描述略有出入）：
 * - 条目为 { server: {...}, _meta: { "io.modelcontextprotocol.registry/official": {...} } }
 * - 字段为 camelCase：registryType / runtimeArguments / environmentVariables / isSecret / isRequired
 * - 分页游标：metadata.nextCursor
 */
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

const REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0/servers";

// ==================== 类型定义 ====================

export interface RegistryRemote {
  type: "streamable-http" | "sse" | string;
  url: string;
  headers?: Array<{ name: string; value: string; description?: string }>;
}

export interface RegistryEnvVar {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
  format?: string;
}

export interface RegistryRuntimeArgument {
  value: string;
  type?: string;
  /** type 为 named 时的参数名（如 --config、-v） */
  name?: string;
  description?: string;
}

export interface RegistryPackage {
  registryType: "npm" | "pypi" | "oci" | string;
  identifier: string;
  version?: string;
  transport?: { type: string };
  runtimeHint?: string;
  runtimeArguments?: RegistryRuntimeArgument[];
  packageArguments?: RegistryRuntimeArgument[];
  environmentVariables?: RegistryEnvVar[];
}

export interface RegistryServer {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  websiteUrl?: string;
  repository?: unknown;
  remotes?: RegistryRemote[];
  packages?: RegistryPackage[];
  /** 顶层 env 声明（部分 server 用；多数在 packages[].environmentVariables） */
  environment_variables?: RegistryEnvVar[];
}

export interface RegistryEntry {
  server: RegistryServer;
  _meta?: {
    "io.modelcontextprotocol.registry/official"?: {
      status?: string;
      isLatest?: boolean;
      publishedAt?: string;
    };
  };
}

export interface RegistrySearchResult {
  entries: RegistryEntry[];
  nextCursor: string | null;
}

// ==================== 查询 ====================

/**
 * 搜索 registry：limit=30 + version=latest；按官方 isLatest 标记去重同名 server。
 * 空查询返回热门（按 registry 默认排序）。
 */
export async function searchRegistryServers(search: string, cursor?: string | null): Promise<RegistrySearchResult> {
  const params = new URLSearchParams({ limit: "30", version: "latest" });
  if (search.trim()) params.set("search", search.trim());
  if (cursor) params.set("cursor", cursor);

  const response = await tauriFetch(`${REGISTRY_BASE}?${params.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Registry 请求失败（HTTP ${response.status}）${text.slice(0, 200)}`);
  }
  const json = (await response.json()) as { servers?: RegistryEntry[]; metadata?: { nextCursor?: string } };

  // 去重：同名 server 仅保留 isLatest=true 的一条（无 official 标记的社区条目照常保留）
  const seen = new Map<string, RegistryEntry>();
  for (const entry of json.servers ?? []) {
    const name = entry.server?.name;
    if (!name) continue;
    const official = entry._meta?.["io.modelcontextprotocol.registry/official"];
    const existing = seen.get(name);
    if (!existing) {
      seen.set(name, entry);
      continue;
    }
    const existingLatest = existing._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest === true;
    if (official?.isLatest === true && !existingLatest) {
      seen.set(name, entry);
    }
  }

  return {
    entries: [...seen.values()],
    nextCursor: json.metadata?.nextCursor ?? null,
  };
}

// ==================== 一键安装映射 ====================

export interface MarketInstallPrefill {
  name: string;
  transport: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
  /** 需要用户补充的 env 变量说明（UI 提示用） */
  envHints: Array<{ name: string; description?: string; isRequired?: boolean; isSecret?: boolean }>;
  /** oci/docker 类一期不支持 */
  unsupported?: string;
}

/** 建议的显示名：registry name 形如 io.github.owner/repo，取最后一段 */
export function suggestDisplayName(registryName: string): string {
  const tail = registryName.split("/").pop() ?? registryName;
  return tail.replace(/[^A-Za-z0-9_-]/g, "-") || "mcp-server";
}

/**
 * 展开 registry 参数为命令行参数：
 * - positional（缺省类型）直接取值
 * - named 展开为 `--name value` 两个参数；name 以 = 结尾时拼为单个 `--name=value`；无 value 视为纯开关
 */
function expandArgs(args: RegistryRuntimeArgument[] | undefined): string[] {
  const out: string[] = [];
  for (const a of args ?? []) {
    if ((a.type ?? "positional") === "named" && a.name) {
      if (a.name.endsWith("=")) out.push(`${a.name}${a.value}`);
      else if (a.value) out.push(a.name, a.value);
      else out.push(a.name);
    } else {
      out.push(a.value);
    }
  }
  return out;
}

/**
 * 将 registry 条目映射为 mcp-store 预填配置：
 * - remotes[].type == "streamable-http" → transport http + url（优先）；sse 次之
 * - packages[].registryType == "npm" → stdio + npx；pypi → uvx；oci → 标不支持
 * - environmentVariables → env 行（is_secret 建议 {{secret:NAME}}）
 */
export function buildInstallPrefill(entry: RegistryEntry): MarketInstallPrefill {
  const server = entry.server;
  const name = suggestDisplayName(server.name);
  const envHints: MarketInstallPrefill["envHints"] = [];

  // 远程优先
  const remote = server.remotes?.find((r) => r.type === "streamable-http") ?? server.remotes?.[0];
  if (remote?.url) {
    const headers: Record<string, string> = {};
    for (const h of remote.headers ?? []) {
      // 占位语法的 header 生成编辑行，用户补值
      headers[h.name] = h.value || "{{secret:NAME}}";
    }
    return {
      name,
      transport: remote.type === "sse" ? "sse" : "http",
      url: remote.url,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      envHints,
    };
  }

  // 本地包
  const pkg = server.packages?.[0];
  if (pkg) {
    for (const v of pkg.environmentVariables ?? []) {
      envHints.push({ name: v.name, description: v.description, isRequired: v.isRequired, isSecret: v.isSecret });
    }
    const env: Record<string, string> = {};
    for (const v of pkg.environmentVariables ?? []) {
      env[v.name] = v.isSecret ? `{{secret:${v.name}}}` : (v.default ?? "");
    }

    if (pkg.registryType === "npm") {
      const ident = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier;
      return {
        name,
        transport: "stdio",
        command: pkg.runtimeHint ?? "npx",
        args: [...expandArgs(pkg.runtimeArguments), ident, ...expandArgs(pkg.packageArguments)],
        env: Object.keys(env).length > 0 ? env : undefined,
        envHints,
      };
    }
    if (pkg.registryType === "pypi") {
      return {
        name,
        transport: "stdio",
        command: "uvx",
        args: [...expandArgs(pkg.runtimeArguments), pkg.identifier, ...expandArgs(pkg.packageArguments)],
        env: Object.keys(env).length > 0 ? env : undefined,
        envHints,
      };
    }
    return {
      name,
      transport: "stdio",
      unsupported: `包类型 ${pkg.registryType}（oci/docker 分发）暂不支持安装`,
      envHints,
    };
  }

  return { name, transport: "http", unsupported: "该条目未提供可用的远程地址或安装包", envHints };
}
