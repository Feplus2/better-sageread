/**
 * P1 写工具安全守卫：transport 层对工具集做包装，按安全模式决定 静默执行 / 确认卡。
 *
 * 决策表集中在 GUARDED_TOOLS + 本文件（改分档只动这里）：
 * - fileWrite（writeFile/editFile）：界内静默；界外 strict/relaxed 确认卡、full 静默
 * - fileRead（readLocalFile/searchFiles）：界内静默；界外 strict 确认卡、relaxed/full 静默
 * - command（runCommand）：strict/relaxed 确认卡、full 静默；任何模式 Rust 侧写审计日志
 * - network（httpRequest）：GET 静默；非 GET 任何模式确认卡（数据离机通道）
 * - mcp_*（批次 B4）：远程 MCP 工具 strict/relaxed 确认卡（server 名 + 工具名 + 参数摘要），
 *   full 静默放行；「本次会话不再询问」按 server 维度记忆（仅内存）
 * - manageMcp（批次 B5）：全动作 Tier 2 确认卡；create/delete 恒确认（唯一 key 使免打扰失效）
 * - manageSecrets：set/delete 恒确认（确认卡不回显密钥真值）；list 静默
 * - manageSkill.delete / manageThreads.delete：破坏性恒确认（其余动作静默）
 *
 * 路径界内/界外判定走 Rust agent_resolve_path（canonicalize + 根前缀，符号链接也绕不过）；
 * allowOutside 放行参数由本层在确认通过/模式放行后注入，不在工具 inputSchema 暴露（模型够不着）。
 */
import { useAgentConfirmStore } from "@/store/agent-confirm-store";
import { resolveWorkspaceRootForScope, useAgentSettingsStore } from "@/store/agent-settings-store";
import { invoke } from "@tauri-apps/api/core";
import type { CoreTool } from "ai";
import { parseMcpToolName } from "../mcp/mcp-manager";
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

/** 确认卡参数摘要：stringify + 截断，避免长参数刷屏 */
function summarizeArgs(args: unknown, max = 300): string {
  try {
    const text = JSON.stringify(args);
    if (text === undefined) return "";
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return String(args);
  }
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
    if (typeof originalExecute !== "function") {
      wrapped[name] = baseTool;
      continue;
    }

    // 批次 B4：远程 MCP 工具（mcp_ 前缀）——strict/relaxed 确认卡，full 静默放行；
    // 「本次会话不再询问该 server」按 server 维度记忆（dontAskKey=mcpServer:{key}，仅内存不落盘）
    if (name.startsWith("mcp_")) {
      wrapped[name] = {
        ...baseTool,
        execute: async (args: any, options: any) => {
          try {
            if (safetyMode === "full") {
              return await originalExecute(args, options);
            }
            const origin = parseMcpToolName(name);
            const approved = await requestWithAbort(
              {
                toolName: name,
                title: `调用 MCP 工具 ${origin?.originalTool ?? name}`,
                detail: `服务器：${origin?.serverName ?? origin?.serverKey ?? "未知"}\n工具：${origin?.originalTool ?? name}\n参数：${summarizeArgs(args)}`,
                dontAskKey: `mcpServer:${origin?.serverKey ?? name}`,
              },
              options?.abortSignal as AbortSignal | undefined,
            );
            if (!approved) return cancelledResult();
            return await originalExecute(args, options);
          } catch (error) {
            return guardFailedResult(error);
          }
        },
      };
      continue;
    }

    // 批次 B5：manageMcp 全动作 Tier 2 确认；create/delete 恒确认（唯一 key 使「不再询问」失效）
    if (name === "manageMcp") {
      wrapped[name] = {
        ...baseTool,
        execute: async (args: any, options: any) => {
          try {
            const action = String(args?.action ?? "");
            const alwaysConfirm = action === "create" || action === "delete";
            const target = String(args?.name ?? args?.id ?? "");
            const approved = await requestWithAbort(
              {
                toolName: name,
                title: `管理 MCP 服务器（${action || "未知动作"}）`,
                detail: summarizeArgs(args, 500),
                dontAskKey: alwaysConfirm
                  ? `manageMcp:${action}:${crypto.randomUUID()}`
                  : `manageMcp:${action}:${target}`,
              },
              options?.abortSignal as AbortSignal | undefined,
            );
            if (!approved) return cancelledResult();
            return await originalExecute(args, options);
          } catch (error) {
            return guardFailedResult(error);
          }
        },
      };
      continue;
    }

    // 密钥保管箱：set/delete 恒确认（唯一 key）；list 仅返回名称，静默放行。
    // 本工具无读出真值通道，确认卡 detail 不含 value 防回显
    if (name === "manageSecrets") {
      wrapped[name] = {
        ...baseTool,
        execute: async (args: any, options: any) => {
          try {
            const action = String(args?.action ?? "");
            if (action !== "set" && action !== "delete") {
              return await originalExecute(args, options);
            }
            const secretName = String(args?.name ?? "");
            const approved = await requestWithAbort(
              {
                toolName: name,
                title: action === "set" ? `保存密钥「${secretName}」到保管箱` : `从保管箱删除密钥「${secretName}」`,
                detail:
                  action === "set"
                    ? `将把用户提供的密钥真值存入系统凭据管理器（密钥内容不回显），之后以 {{secret:${secretName}}} 引用`
                    : `删除后引用 {{secret:${secretName}}} 的配置将失效`,
                dontAskKey: `manageSecrets:${action}:${crypto.randomUUID()}`,
              },
              options?.abortSignal as AbortSignal | undefined,
            );
            if (!approved) return cancelledResult();
            return await originalExecute(args, options);
          } catch (error) {
            return guardFailedResult(error);
          }
        },
      };
      continue;
    }

    // 笔记写入恒确认（笔记面板铁边界 2026-08-11：AI 落笔前用户过目——确认卡即草稿预览，
    // 唯一 key 使「不再询问」失效）；list/read/toggleStar/export 静默（export 经系统保存对话框，天然有确认）
    if (name === "manageNotes") {
      wrapped[name] = {
        ...baseTool,
        execute: async (args: any, options: any) => {
          try {
            const action = String(args?.action ?? "");
            if (action !== "create" && action !== "update") {
              return await originalExecute(args, options);
            }
            const title = String(args?.title ?? "");
            const contentPreview = String(args?.content ?? "").slice(0, 500);
            const modeText = action === "create" ? "新建笔记" : `修改笔记（${String(args?.mode ?? "append")} 模式）`;
            const approved = await requestWithAbort(
              {
                toolName: name,
                title: `${modeText}${title ? `「${title}」` : ""}`,
                detail: `将写入笔记面板的内容草稿：\n${contentPreview}${String(args?.content ?? "").length > 500 ? "…" : ""}`,
                dontAskKey: `manageNotes:${action}:${crypto.randomUUID()}`,
              },
              options?.abortSignal as AbortSignal | undefined,
            );
            if (!approved) return cancelledResult();
            return await originalExecute(args, options);
          } catch (error) {
            return guardFailedResult(error);
          }
        },
      };
      continue;
    }

    // 破坏性动作恒确认（用户拍板 2026-08-06：删除能力要给，但破坏性操作必问）：
    // manageSkill.delete / manageThreads.delete；其余动作静默
    if (name === "manageSkill" || name === "manageThreads") {
      wrapped[name] = {
        ...baseTool,
        execute: async (args: any, options: any) => {
          try {
            const action = String(args?.action ?? "");
            if (action !== "delete") {
              return await originalExecute(args, options);
            }
            const target = String(args?.skillName ?? args?.threadId ?? "");
            const approved = await requestWithAbort(
              {
                toolName: name,
                title: name === "manageSkill" ? `删除技能「${target}」` : `删除对话（${target}）`,
                detail: summarizeArgs(args, 300),
                dontAskKey: `${name}:delete:${crypto.randomUUID()}`,
              },
              options?.abortSignal as AbortSignal | undefined,
            );
            if (!approved) return cancelledResult();
            return await originalExecute(args, options);
          } catch (error) {
            return guardFailedResult(error);
          }
        },
      };
      continue;
    }

    // 批次 F4：importPaper Tier 2 确认（解析重操作，会拉起 Papers_Converter sidecar 长时间运行）；
    // strict/relaxed 确认、full 静默，同一文件免打扰
    if (name === "importPaper") {
      wrapped[name] = {
        ...baseTool,
        execute: async (args: any, options: any) => {
          try {
            if (safetyMode === "full") {
              return await originalExecute(args, options);
            }
            const filePath = String(args?.filePath ?? "");
            const approved = await requestWithAbort(
              {
                toolName: name,
                title: "解析并导入论文",
                detail: filePath,
                dontAskKey: `importPaper:${filePath}`,
              },
              options?.abortSignal as AbortSignal | undefined,
            );
            if (!approved) return cancelledResult();
            return await originalExecute(args, options);
          } catch (error) {
            return guardFailedResult(error);
          }
        },
      };
      continue;
    }

    // I1：processPaper action=reparse 为破坏性动作（替换正文，译文转陈旧/对齐需重建）→ 恒确认
    // （唯一 key 使「不再询问」失效）；其余动作（status/translate/align）走正常确认流程
    if (name === "processPaper") {
      wrapped[name] = {
        ...baseTool,
        execute: async (args: any, options: any) => {
          try {
            const action = String(args?.action ?? "");
            if (action !== "reparse" || safetyMode === "full") {
              return await originalExecute(args, options);
            }
            const paperId = String(args?.paperId ?? "");
            const approved = await requestWithAbort(
              {
                toolName: name,
                title: "重新解析论文（替换正文）",
                detail: `论文 ${paperId} 将用源 PDF 重新解析并替换现有正文；已有译文转陈旧（续翻自动更新），句词对齐需重建`,
                dontAskKey: `processPaper:reparse:${crypto.randomUUID()}`,
              },
              options?.abortSignal as AbortSignal | undefined,
            );
            if (!approved) return cancelledResult();
            return await originalExecute(args, options);
          } catch (error) {
            return guardFailedResult(error);
          }
        },
      };
      continue;
    }

    if (!spec) {
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
              // A4：界外读在 relaxed/full 下静默放行，但需注入 allowOutside 过 Rust 侧拦截
              const readGrant = spec.action === "fileRead" ? { allowOutside: true } : grant;
              return await originalExecute({ ...baseArgs, ...readGrant }, options);
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

          // A4：界外读经确认卡放行后同样注入 allowOutside
          const finalGrant = spec.action === "fileRead" ? { ...grant, allowOutside: true } : grant;
          return await originalExecute({ ...baseArgs, ...finalGrant }, options);
        } catch (error) {
          return guardFailedResult(error);
        }
      },
    };
  }
  return wrapped;
}
