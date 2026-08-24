import { useLayoutStore } from "@/store/layout-store";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router";

/**
 * 右下角进度卡共享栈（2026-08-23 v3：禁区感知）：
 * 多张进度卡纵向堆叠不覆盖；容器由 BottomRightStackHost 渲染（挂 reader-layout），
 * 在阅读标签页（书籍/论文）与全局助手聊天页自动隐藏（禁区，与 global-convert-progress 同口径）。
 * 卡片经 <BottomRightPortal> 进入容器。
 *
 * 动效批次 1：卡片出入场走 <MotionStackCard>（.motion-stack-item，index.css motion token）——
 * show 翻 false 时不立即卸载，先挂 .motion-closing 播完离场动画再 unmount；
 * 离场期间保留最后一次渲染的子树（数据已定格，快照即收尾数据）。
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

/** 读取 --motion-dur-base 计算值（ms）：离场延迟随三档 token 走，fallback 0 = token 缺失时硬切 */
function readMotionBaseMs(): number {
  if (typeof window === "undefined") return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--motion-dur-base").trim();
  const ms = /^([\d.]+)ms$/.exec(raw);
  if (ms) return Number(ms[1]);
  const s = /^([\d.]+)s$/.exec(raw);
  return s ? Number(s[1]) * 1000 : 0;
}

/**
 * 进度卡出入场编排（离场延迟卸载）：show=false → 挂 .motion-closing，播完 card-out 动画才卸载；
 * 期间 show 翻回 true 则取消离场、原地恢复（内容实时刷新）。closing 期渲染最后一份子树快照。
 */
export function MotionStackCard({ show, children }: { show: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(show);
  const [closing, setClosing] = useState(false);
  const lastChildrenRef = useRef(children);
  if (show && children != null) lastChildrenRef.current = children;

  useEffect(() => {
    if (show) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const timer = window.setTimeout(
      () => {
        setMounted(false);
        setClosing(false);
      },
      // 动画时长 + 余量；reduced 档 token 为 0.01ms，约等于立即卸载
      readMotionBaseMs() + 40,
    );
    return () => window.clearTimeout(timer);
  }, [show, mounted]);

  if (!mounted) return null;
  return (
    <BottomRightPortal>
      <div className={closing ? "motion-stack-item motion-closing" : "motion-stack-item"}>
        {show ? children : lastChildrenRef.current}
      </div>
    </BottomRightPortal>
  );
}
