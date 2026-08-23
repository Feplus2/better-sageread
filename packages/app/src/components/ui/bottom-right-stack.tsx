import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * 右下角进度卡共享栈（2026-08-23）：
 * 向量化/翻译/解析/Zotero 导入等多张进度卡原本各自 fixed right-4 bottom-4，
 * 同时出现时互相覆盖。本组件提供唯一容器，各卡 Portal 进入后自动纵向堆叠。
 *
 * 用法：卡片外层包 <BottomRightPortal>…卡片…</BottomRightPortal>。
 * 容器 pointer-events-none，卡片自身需要 pointer-events-auto（现有卡已有交互）。
 */

const STACK_ID = "bottom-right-stack";

function ensureStack(): HTMLElement {
  let el = document.getElementById(STACK_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = STACK_ID;
    el.className = "pointer-events-none fixed right-4 bottom-4 z-40 flex flex-col items-end gap-2";
    document.body.appendChild(el);
  }
  return el;
}

export function BottomRightPortal({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(ensureStack());
  }, []);
  if (!target) return null;
  return createPortal(<div className="pointer-events-auto">{children}</div>, target);
}
