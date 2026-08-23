import { useLayoutStore } from "@/store/layout-store";
import { type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router";

/**
 * 右下角进度卡共享栈（2026-08-23 v3：禁区感知）：
 * 多张进度卡纵向堆叠不覆盖；容器由 BottomRightStackHost 渲染（挂 reader-layout），
 * 在阅读标签页（书籍/论文）与全局助手聊天页自动隐藏（禁区，与 global-convert-progress 同口径）。
 * 卡片经 <BottomRightPortal> 进入容器。
 */

const STACK_ID = "bottom-right-stack";

/** 容器宿主：挂载一次（reader-layout），按视图状态显示/隐藏整个栈 */
export function BottomRightStackHost() {
  const isHomeActive = useLayoutStore((s) => s.isHomeActive);
  const location = useLocation();
  const exempt = !isHomeActive || location.pathname === "/chat";
  return (
    <div
      id={STACK_ID}
      style={exempt ? { display: "none" } : undefined}
      className="pointer-events-none fixed right-4 bottom-4 z-40 flex flex-col items-end gap-2"
    />
  );
}

export function BottomRightPortal({ children }: { children: ReactNode }) {
  const target = typeof document !== "undefined" ? document.getElementById(STACK_ID) : null;
  if (!target) return null;
  return createPortal(<div className="pointer-events-auto">{children}</div>, target);
}
