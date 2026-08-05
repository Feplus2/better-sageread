/**
 * P1 写工具安全守卫：transport 层对工具集做包装，按安全模式决定 静默执行 / 确认卡。
 *
 * 决策表集中在 GUARDED_TOOLS + 本文件（改分档只动这里）：
 * - fileWrite（writeFile/editFile）：界内静默；界外 strict/relaxed 确认卡、full 静默
 * - fileRead（readLocalFile/searchFiles）：界内静默；界外 strict 确认卡、relaxed/full 静默
 * - command（runCommand）：strict/relaxed 确认卡、full 静默；任何模式 Rust 侧写审计日志
 * - network（httpRequest）：GET 静默；非 GET 任何模式确认卡（数据离机通道）
 *
 * 路径界内/界外判定走 Rust agent_resolve_path（canonicalize + 根前缀，符号链接也绕不过）；
 * allowOutside 放行参数由本层在确认通过/模式放行后注入，不在工具 inputSchema 暴露（模型够不着）。
 */
import { useAgentConfirmStore } from "@/store/agent-confirm-store";
import { resolveWorkspaceRootForScope, useAgentSettingsStore } from "@/store/agent-settings-store";
import { invoke } from "@tauri-apps/api/core";
import type { CoreTool } from "ai";
import type { AgentScope } from "../tools/registry";

interface GuardVerdict {
  verdict: "in" | "out";
  resolved: string;
  exists: boolean;
  isDir: boolean;
}

type GuardAction = "fileWrite" | "fileRead" | "command" | "network";

interface GuardSpec {
  action: GuardAction;
  /** 文件类：入参中携带路径的字段名 */
  pathArg: string;
  title: string;
}

const GUARDED_TOOLS: Record<string, GuardSpec> = {
  writeFile: { action: "fileWrite", pathArg: "path", title: "写入工作区外文件" },
  editFile: { action: "fileWrite", pathArg: "path", title: "修改工作区外文件" },
  readLocalFile: { action: "fileRead", pathArg: "path", title: "读取工作区外路径" },
  searchFiles: { action: "fileRead", pathArg: "subdir", title: "搜索工作区外目录" },
  runCommand: { action: "command", pathArg: "", title: "执行命令" },
  httpRequest: { action: "network", pathArg: "", title: "发送网络请求" },
};

function cancelledResult() {
  return {
    results: { success: false, message: "用户已拒绝本次操作" },
    meta: { cancelled: true },
  };
}

function guardFailedResult(error: unknown) {
  return {
    results: {
      success: false,
      message: `安全守卫检查失败：${error instanceof Error ? error.message : String(error)}`,
    },
    meta: {},
  };
}

/** 确认请求（挂起等待用户），同时响应流中止：中止即撤卡并按拒绝处理 */
function requestWithAbort(
  req: { toolName: string; title: string; detail: string; dontAskKey: string },
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      useAgentConfirmStore.getState().dropByKey(req.dontAskKey);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    useAgentConfirmStore
      .getState()
      .requestConfirmation(req)
      .then((approved) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(approved);
      })
      .catch(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(false);
      });
  });
}

export function wrapToolsWithGuard(tools: Record<string, CoreTool>, agentScope: AgentScope): Record<string, CoreTool> {
  const { safetyMode } = useAgentSettingsStore.getState();
  // 共享根 + 按助手覆盖（2026-08-05 拍板）：本 scope 生效根，判界与注入都用它
  const scopeRoot = resolveWorkspaceRootForScope(agentScope);

  const wrapped: Record<string, CoreTool> = {};
  for (const [name, baseTool] of Object.entries(tools)) {
    const spec = GUARDED_TOOLS[name];
    const originalExecute = baseTool.execute;
    if (!spec || typeof originalExecute !== "function") {
      wrapped[name] = baseTool;
      continue;
    }

    wrapped[name] = {
      ...baseTool,
      execute: async (args: any, options: any) => {
        try {
          let title = spec.title;
          let detail = "";
          let dontAskKey = "";
          // 界外写入时确认通过/模式放行后注入 Rust 侧放行标记
          let grant: Record<string, unknown> = {};
          // scope 生效根注入（不进模型 schema，与 allowOutside 同通道）；network 类无根概念
          const baseArgs = spec.action === "network" ? args : { ...args, rootOverride: scopeRoot };

          if (spec.action === "fileWrite" || spec.action === "fileRead") {
            const rawPath = args?.[spec.pathArg];
            // searchFiles 未指定 subdir 时搜索整个工作区（界内），直通
            if (typeof rawPath !== "string" || !rawPath.trim()) {
              return await originalExecute(baseArgs, options);
            }
            const verdict = await invoke<GuardVerdict>("agent_resolve_path", {
              root: scopeRoot,
              path: rawPath,
            });
            if (verdict.verdict !== "out") {
              return await originalExecute(baseArgs, options);
            }
            if (spec.action === "fileWrite") {
              grant = { allowOutside: true };
            }
            const needConfirm = spec.action === "fileWrite" ? safetyMode !== "full" : safetyMode === "strict";
            if (!needConfirm) {
              return await originalExecute({ ...baseArgs, ...grant }, options);
            }
            detail = verdict.resolved;
            dontAskKey = `${name}:${verdict.resolved}`;
          } else if (spec.action === "command") {
            if (safetyMode === "full") {
              return await originalExecute(baseArgs, options);
            }
            detail = String(args?.command ?? "");
            dontAskKey = `runCommand:${detail}`;
          } else {
            // network：非 GET 全模式确认
            const method = String(args?.method ?? "GET").toUpperCase();
            if (method === "GET") {
              return await originalExecute(baseArgs, options);
            }
            let host = "";
            try {
              host = new URL(String(args?.url ?? "")).host;
            } catch {
              host = "";
            }
            title = `发送网络 ${method} 请求`;
            detail = `${method} ${String(args?.url ?? "")}`;
            dontAskKey = `httpRequest:${method}:${host}`;
          }

          const approved = await requestWithAbort(
            { toolName: name, title, detail, dontAskKey },
            options?.abortSignal as AbortSignal | undefined,
          );
          if (!approved) return cancelledResult();

          return await originalExecute({ ...baseArgs, ...grant }, options);
        } catch (error) {
          return guardFailedResult(error);
        }
      },
    };
  }
  return wrapped;
}
