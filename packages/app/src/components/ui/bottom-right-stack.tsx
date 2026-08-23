import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * 右下角进度卡共享栈（2026-08-23 v2 同步版）：
 * 多张进度卡同时出现时纵向堆叠不覆盖。v1 的 useEffect+useState 有一帧延迟且在
 * React 并发模式下可能不触发重渲染——改为模块级同步创建，Portal 立即生效。
 *
 * 用法：卡片外层包 <BottomRightPortal>…卡片…</BottomRightPortal>。
 * 容器 pointer-events-none，卡片 wrapper pointer-events-auto。
 */

const STACK_ID = "bottom-right-stack";

function ensureStack(): HTMLElement {
  if (typeof document === "undefined") return {} as HTMLElement;
  let el = document.getElementById(STACK_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = STACK_ID;
    el.className = "pointer-events-none fixed right-4 bottom-4 z-40 flex flex-col items-end gap-2";
    document.body.appendChild(el);
  }
  return el;
}

// 模块级同步创建——import 时即挂载，无 useEffect 延迟
const stackEl = ensureStack();

export function BottomRightPortal({ children }: { children: ReactNode }) {
  return createPortal(<div className="pointer-events-auto">{children}</div>, stackEl);
}
