import clsx from "clsx";
import {
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * 动效批次 4：侧栏开合动效（docs/motion-system-plan.md 裁定三口径 2「冻结式」+ 第七节序 4）。
 *
 * 阅读器侧栏三件套（书籍 tab 与论文 tab 共用）：
 * - <SidebarMotionProvider>：一行 flex 阅读区的冻结编排器。侧栏动画期间把内容钉层宽度钉死
 *   （EPUB iframe 不 resize → 不逐帧重分页；Markdown 大 DOM 不逐帧重排），动画结束帧拆钉，
 *   一次性 reflow 并触发 onReflow（阅读器据此发一次 foliate-resize-update）。
 *   冻结状态收在单个 ref 对象（ref-count 叠架/拆除幂等）：两侧栏同时动画、快速连打都不会
 *   钉两层或忘拆。
 * - <SidebarMotionPin>：内容钉层（冻结目标）。钉取「侧栏挂载前」的宽度——挂载提交后再量已缩，
 *   故宽度由 ResizeObserver 持续记录。锚定方位 = 侧栏对侧（侧栏在左 → 内容锚右），
 *   块级上下文用 margin-left:auto（可为负吸收溢出），flex 交叉轴靠 align-self 兜底。
 * - <MotionSidebar>：侧栏壳。开合只碰 transform/opacity（translateX ±var(--motion-sidebar-shift)
 *   + 淡入淡出），CSS transition 天然可中断反向；离场播完再卸载（closing 编排同批次 1 进度卡先例）。
 *   壳只加一层 h-full 包裹 div，终态布局/宽度/间距与硬切时代逐像素一致；开合触发语义不变。
 *
 * <MotionSidebarCollapse>：书库侧栏标签列表开合（场景 2，无 iframe/大 DOM，真推移）。
 * 受控例外：width 过渡动 layout（仅 w-48 小组件，见 index.css .motion-sidebar-collapse 注释）。
 */

/** 读取 --motion-dur-base 计算值（ms）：落定兜底定时器随三档 token 走（同 bottom-right-stack 口径） */
function readMotionBaseMs(): number {
  if (typeof window === "undefined") return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--motion-dur-base").trim();
  const ms = /^([\d.]+)ms$/.exec(raw);
  if (ms) return Number(ms[1]);
  const s = /^([\d.]+)s$/.exec(raw);
  return s ? Number(s[1]) * 1000 : 0;
}

/** 内容锚定方位（= 侧栏对侧）：侧栏在左 → 内容锚右（右缘不动，左缘被侧栏覆盖/让出） */
type ContentAnchor = "left" | "right";

interface SidebarMotionManager {
  attachPin: (el: HTMLDivElement | null) => void;
  /** 冻结叠架（幂等，ref-count；首次叠架才钉，锚定取首层方位） */
  begin: (anchor: ContentAnchor) => void;
  /** 拆除一层冻结；归零时恢复钉层样式并触发 onReflow（一次性 reflow 落定） */
  end: () => void;
}

const SidebarMotionContext = createContext<SidebarMotionManager | null>(null);

/** 拆钉时要恢复的钉层/包裹层原值快照 */
interface PinSaved {
  width: string;
  marginLeft: string;
  alignSelf: string;
  wrapperOverflow: string;
}

export function SidebarMotionProvider({ onReflow, children }: { onReflow?: () => void; children: ReactNode }) {
  const pinElRef = useRef<HTMLDivElement | null>(null);
  const lastWidthRef = useRef<number | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const onReflowRef = useRef(onReflow);
  onReflowRef.current = onReflow;
  // 冻结状态单点管理：叠架计数 + 拆前快照（连打/双栏同动不钉两层、不忘拆）
  const stRef = useRef<{ count: number; saved: PinSaved | null }>({ count: 0, saved: null });

  const attachPin = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    pinElRef.current = el;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) lastWidthRef.current = entry.contentRect.width;
    });
    ro.observe(el);
    roRef.current = ro;
  }, []);

  const begin = useCallback((anchor: ContentAnchor) => {
    const st = stRef.current;
    st.count++;
    if (st.saved) return; // 已冻结：叠架只计数
    const pin = pinElRef.current;
    if (!pin) return; // 钉层缺席（视图休眠/加载中分支）：计数照走，无钉可钉
    const wrapper = pin.parentElement;
    const w = lastWidthRef.current ?? pin.getBoundingClientRect().width;
    st.saved = {
      width: pin.style.width,
      marginLeft: pin.style.marginLeft,
      alignSelf: pin.style.alignSelf,
      wrapperOverflow: wrapper?.style.overflow ?? "",
    };
    pin.style.width = `${w}px`;
    if (anchor === "right") {
      pin.style.marginLeft = "auto";
      pin.style.alignSelf = "flex-end";
    }
    if (wrapper) wrapper.style.overflow = "hidden";
  }, []);

  const end = useCallback(() => {
    const st = stRef.current;
    if (st.count === 0) return;
    st.count--;
    if (st.count > 0) return;
    const saved = st.saved;
    st.saved = null;
    const pin = pinElRef.current;
    if (saved && pin) {
      pin.style.width = saved.width;
      pin.style.marginLeft = saved.marginLeft;
      pin.style.alignSelf = saved.alignSelf;
      const wrapper = pin.parentElement;
      if (wrapper) wrapper.style.overflow = saved.wrapperOverflow;
      // 拆钉即一次性 reflow（EPUB 此刻容器才变宽 → paginator 自身 ResizeObserver 重分页一次）
      onReflowRef.current?.();
    }
  }, []);

  const value = useMemo<SidebarMotionManager>(() => ({ attachPin, begin, end }), [attachPin, begin, end]);
  return <SidebarMotionContext.Provider value={value}>{children}</SidebarMotionContext.Provider>;
}

/** 内容钉层：冻结目标。渲染一个普通 div（默认无样式差异），把节点注册进编排器 */
export function SidebarMotionPin({
  ref,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }) {
  const mgr = useContext(SidebarMotionContext);
  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      mgr?.attachPin(el);
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [mgr, ref],
  );
  return (
    <div ref={setRefs} {...rest}>
      {children}
    </div>
  );
}

type MotionPhase = "idle" | "enter" | "exit";

interface MotionMachine {
  phase: MotionPhase;
  pinned: boolean;
  raf1: number;
  raf2: number;
  timer: number;
}

/**
 * 阅读器侧栏滑入滑出壳（冻结式）。open 只控制编排，不直接条件渲染：
 * 开 = 挂载 + 冻结内容 + translateX 滑入（播完拆钉一次性 reflow）；
 * 合 = 滑出（期间布局不动）→ 卸载提交 + 拆钉同一帧一次性 reflow。
 * 快速连打：transition 从当前 transform 值反向，无跳变。
 */
export function MotionSidebar({
  open,
  side,
  className,
  children,
}: {
  open: boolean;
  /** 侧栏方位（含 swapSidebars 之后）：滑入方向与内容锚定都由它推出 */
  side: "left" | "right";
  className?: string;
  children: ReactNode;
}) {
  const mgr = useContext(SidebarMotionContext);
  // 首挂载 open=true（如应用启动即展开）：直接落定态，与硬切时代首帧一致，不播进场
  const [mounted, setMounted] = useState(open);
  const [off, setOff] = useState(!open); // true = 屏外位（translateX ±shift + opacity 0）
  const rootRef = useRef<HTMLDivElement>(null);
  const st = useRef<MotionMachine>({ phase: "idle", pinned: false, raf1: 0, raf2: 0, timer: 0 }).current;
  // 兜底定时器里的 settle 是武装时刻的闭包，off 经 ref 读现值（定时器触发时渲染已推进）
  const offRef = useRef(off);
  offRef.current = off;

  const pin = useCallback(() => {
    if (st.pinned) return;
    st.pinned = true;
    mgr?.begin(side === "left" ? "right" : "left"); // 内容锚到侧栏对侧
  }, [mgr, side, st]);

  const unpin = useCallback(() => {
    if (!st.pinned) return;
    st.pinned = false;
    mgr?.end();
  }, [mgr, st]);

  const clearTimers = useCallback(() => {
    cancelAnimationFrame(st.raf1);
    cancelAnimationFrame(st.raf2);
    window.clearTimeout(st.timer);
  }, [st]);

  /** 落定（transitionend 或兜底定时器驱动，幂等）：进场播完拆钉；离场播完卸载（卸载提交后拆钉） */
  const settle = useCallback(() => {
    if (st.phase === "enter" && !offRef.current) {
      st.phase = "idle";
      clearTimers();
      unpin();
    } else if (st.phase === "exit" && offRef.current) {
      st.phase = "idle";
      clearTimers();
      setMounted(false);
    }
  }, [st, unpin, clearTimers]);

  const armFallback = useCallback(() => {
    window.clearTimeout(st.timer);
    st.timer = window.setTimeout(settle, readMotionBaseMs() + 120);
  }, [st, settle]);

  // 开合方向编排
  useLayoutEffect(() => {
    if (open && !mounted) {
      st.phase = "enter";
      setOff(true);
      setMounted(true);
      return;
    }
    if (open && mounted && st.phase === "exit") {
      // 离场中断 → 从当前位置反向滑回
      st.phase = "enter";
      cancelAnimationFrame(st.raf1);
      cancelAnimationFrame(st.raf2);
      st.raf1 = requestAnimationFrame(() => {
        st.raf2 = requestAnimationFrame(() => {
          setOff(false);
          armFallback();
        });
      });
      return;
    }
    if (!open && mounted && st.phase !== "exit") {
      st.phase = "exit";
      pin(); // 收起同样冻结：终结帧（卸载提交）才一次性 reflow
      setOff(true);
      armFallback();
    }
  }, [open, mounted, st, pin, armFallback]);

  // 进场挂载提交：先冻结（本提交即钉死，首帧无内容重排），双 rAF 后放屏外位 → 滑入；
  // 卸载提交后：拆钉 → 一次性 reflow（onReflow）
  useLayoutEffect(() => {
    if (!mounted) {
      unpin();
      return;
    }
    if (st.phase === "enter" && off) {
      pin();
      cancelAnimationFrame(st.raf1);
      cancelAnimationFrame(st.raf2);
      st.raf1 = requestAnimationFrame(() => {
        st.raf2 = requestAnimationFrame(() => {
          setOff(false);
          armFallback();
        });
      });
    }
  }, [mounted, off, st, pin, unpin, armFallback]);

  // 组件整体卸载（tab 关闭等）兜底：清定时器 + 拆钉（防冻结残留）
  useLayoutEffect(() => {
    return () => {
      clearTimers();
      unpin();
    };
  }, [clearTimers, unpin]);

  if (!mounted) return null;
  const dir = side === "left" ? -1 : 1;
  return (
    <div
      ref={rootRef}
      className={clsx("motion-sidebar h-full", className)}
      style={{
        transform: off ? `translateX(calc(var(--motion-sidebar-shift) * ${dir}))` : "none",
        opacity: off ? 0 : 1,
      }}
      onTransitionEnd={(e) => {
        // 不限 propertyName：fade-only 下位移恒等无 transform 过渡，只有 opacity 过渡 end 事件；settle 幂等
        if (e.target === rootRef.current) settle();
      }}
    >
      {children}
    </div>
  );
}

/**
 * 书库侧栏标签列表开合（场景 2）：宽度 0↔目标 + opacity（受控例外，见 index.css 注释），
 * 内部内容定宽（= 目标宽）防文字动画中折行；closing 态播完离场再卸载（同批次 1 先例）。
 */
export function MotionSidebarCollapse({
  open,
  className,
  children,
}: {
  open: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  const [collapsed, setCollapsed] = useState(!open);
  const [targetW, setTargetW] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const st = useRef<MotionMachine>({ phase: "idle", pinned: false, raf1: 0, raf2: 0, timer: 0 }).current;
  // 兜底定时器里的 settle 是武装时刻的闭包，collapsed 经 ref 读现值
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  const clearTimers = useCallback(() => {
    cancelAnimationFrame(st.raf1);
    cancelAnimationFrame(st.raf2);
    window.clearTimeout(st.timer);
  }, [st]);

  const settle = useCallback(() => {
    if (st.phase === "enter" && !collapsedRef.current) {
      st.phase = "idle";
      clearTimers();
    } else if (st.phase === "exit" && collapsedRef.current) {
      st.phase = "idle";
      clearTimers();
      setMounted(false);
    }
  }, [st, clearTimers]);

  const armFallback = useCallback(() => {
    window.clearTimeout(st.timer);
    st.timer = window.setTimeout(settle, readMotionBaseMs() + 120);
  }, [st, settle]);

  useLayoutEffect(() => {
    if (open && !mounted) {
      st.phase = "enter";
      setCollapsed(true);
      setMounted(true);
      return;
    }
    if (open && mounted && st.phase === "exit") {
      // 离场中断 → 反向展开
      st.phase = "enter";
      cancelAnimationFrame(st.raf1);
      cancelAnimationFrame(st.raf2);
      st.raf1 = requestAnimationFrame(() => {
        st.raf2 = requestAnimationFrame(() => {
          setCollapsed(false);
          armFallback();
        });
      });
      return;
    }
    if (!open && mounted && st.phase !== "exit") {
      st.phase = "exit";
      setCollapsed(true);
      armFallback();
    }
  }, [open, mounted, st, armFallback]);

  // 挂载后量目标宽（父容器内容宽：侧栏 w-48 恒定，标签列表天然撑满；与子内容宽度无关，收起态量也准）；
  // 进场首帧（collapsed）后双 rAF 放出 0→目标
  useLayoutEffect(() => {
    if (!mounted) return;
    if (targetW == null) {
      const parent = rootRef.current?.parentElement;
      if (parent) setTargetW(parent.clientWidth);
    }
    if (st.phase === "enter" && collapsed) {
      cancelAnimationFrame(st.raf1);
      cancelAnimationFrame(st.raf2);
      st.raf1 = requestAnimationFrame(() => {
        st.raf2 = requestAnimationFrame(() => {
          setCollapsed(false);
          armFallback();
        });
      });
    }
  }, [mounted, collapsed, targetW, st, armFallback]);

  useLayoutEffect(() => {
    return () => clearTimers();
  }, [clearTimers]);

  if (!mounted) return null;
  const w = targetW ?? 0;
  return (
    <div
      ref={rootRef}
      className={clsx("motion-sidebar-collapse", className)}
      style={{
        // 起点宽 calc(目标 × var(--motion-collapse-from))：full=0 做宽度推移；fade-only/reduced=1 纯 fade
        width: collapsed ? `calc(${w}px * var(--motion-collapse-from))` : targetW != null ? `${w}px` : "auto",
        opacity: collapsed ? 0 : 1,
      }}
      onTransitionEnd={(e) => {
        if (e.target === rootRef.current) settle();
      }}
    >
      {/* 内部内容定宽（= 目标宽）：宽度推移期间文字不折行 */}
      <div style={targetW != null ? { width: `${targetW}px` } : undefined}>{children}</div>
    </div>
  );
}
