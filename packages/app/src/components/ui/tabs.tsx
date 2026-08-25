import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as React from "react";

import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

/** 滑动气泡模式开关（批次 3）：水平 TabsList 提供 true，Trigger 据此撤掉自带 active 底色/阴影（由 pill 接管） */
const TabsPillContext = React.createContext(false);

interface PillBox {
  left: number;
  top: number;
  width: number;
  height: number;
  radius: string;
}

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, children, ...props }, ref) => {
  const listRef = React.useRef<HTMLDivElement | null>(null);
  // pill 位置盒；null = 未定位（不渲染，禁止从 0,0 飞入）
  const [pill, setPill] = React.useState<PillBox | null>(null);
  // 首次定位不设过渡：挂载后的下一帧才打开过渡开关
  const [animated, setAnimated] = React.useState(false);
  // 竖排 List 不渲染 pill、不提供 pillEnabled（触发器保持原样式）
  const [vertical, setVertical] = React.useState(false);

  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      listRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  // 测量活跃触发器相对 list 的偏移（offsetParent = relative 的 list）；圆角同源自取，适配 rounded-full 使用方
  const measure = React.useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>('[data-state="active"]');
    if (!active) {
      setPill(null);
      return;
    }
    setPill({
      left: active.offsetLeft,
      top: active.offsetTop,
      width: active.offsetWidth,
      height: active.offsetHeight,
      radius: getComputedStyle(active).borderRadius,
    });
  }, []);

  React.useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const isVertical = () => list.dataset.orientation === "vertical";
    setVertical(isVertical());
    const update = () => {
      if (isVertical()) {
        setPill(null);
        setVertical(true);
        return;
      }
      measure();
    };
    update(); // 挂载即首次定位（useLayoutEffect 同步提交，首帧无裸奔也无飞入）
    const raf = requestAnimationFrame(() => setAnimated(true));
    // data-state 翻转 / 触发器增删 / 类名变化 → 重测；list 尺寸变化（字体加载、容器拉伸）→ 重测
    const mo = new MutationObserver(update);
    mo.observe(list, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ["data-state", "data-orientation", "class", "style"],
    });
    const ro = new ResizeObserver(update);
    ro.observe(list);
    return () => {
      cancelAnimationFrame(raf);
      mo.disconnect();
      ro.disconnect();
    };
  }, [measure]);

  const pillEnabled = !vertical;

  return (
    <TabsPrimitive.List
      ref={setRefs}
      className={cn(
        "relative inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground",
        className,
      )}
      {...props}
    >
      <TabsPillContext.Provider value={pillEnabled}>
        {pillEnabled && pill && (
          <span
            aria-hidden="true"
            className="absolute top-0 left-0 bg-background shadow-sm"
            style={{
              // transform 负责位移；width 联动是小元素（绝对定位、无兄弟回流）布局动画，
              // 属规格批准的受控例外；时长/缓动只引用 token
              transform: `translate(${pill.left}px, ${pill.top}px)`,
              width: pill.width,
              height: pill.height,
              borderRadius: pill.radius,
              transition: animated
                ? "transform var(--motion-dur-fast) var(--motion-ease), width var(--motion-dur-fast) var(--motion-ease)"
                : "none",
            }}
          />
        )}
        {children}
      </TabsPillContext.Provider>
    </TabsPrimitive.List>
  );
});
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => {
  const pillEnabled = React.useContext(TabsPillContext);
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 font-medium text-sm ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-foreground",
        // pill 模式：active 底色/阴影由 pill 接管，触发器仅保留文字色并浮到 pill 之上；
        // 非 pill（竖排）：维持原自带 active 样式
        pillEnabled ? "relative z-10" : "data-[state=active]:bg-background data-[state=active]:shadow-sm",
        className,
      )}
      {...props}
    />
  );
});
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
