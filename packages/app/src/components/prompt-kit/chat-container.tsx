import { cn } from "@/lib/utils";
import type { UIMessage } from "ai";
import { useEffect, useRef } from "react";
import { StickToBottom, type StickToBottomContext, useStickToBottomContext } from "use-stick-to-bottom";
import { ChatMessageRail } from "./chat-message-rail";
import { type ChatNavBridge, ChatNavBridgeContext } from "./chat-nav-bridge";

export type ChatContainerRootProps = {
  children: React.ReactNode;
  className?: string;
  autoScroll?: boolean;
  resize?: "auto" | "instant" | "smooth";
  initial?: "auto" | "instant" | "smooth" | boolean;
  contextRef?: React.RefObject<StickToBottomContext>;
  /** 传入则在聊天区右缘渲染消息导航条（轮次刻度 + 悬浮缩略列表） */
  navMessages?: UIMessage[];
} & React.HTMLAttributes<HTMLDivElement>;

function AutoScrollController({ autoScroll }: { autoScroll: boolean }) {
  const { stopScroll } = useStickToBottomContext();

  useEffect(() => {
    if (!autoScroll) {
      stopScroll();
    }
  }, [autoScroll, stopScroll]);

  return null;
}

export type ChatContainerContentProps = {
  children: React.ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>;

export type ChatContainerScrollAnchorProps = {
  className?: string;
  ref?: React.RefObject<HTMLDivElement>;
} & React.HTMLAttributes<HTMLDivElement>;

function ChatContainerRoot({
  children,
  className,
  autoScroll = true,
  // 内容增高（流式每多一行）时用弹簧动画平滑跟随底部；instant 会让整页每长一行就瞬间跳一行
  resize = "smooth",
  initial = "instant",
  contextRef,
  navMessages,
  ...props
}: ChatContainerRootProps) {
  const bridgeRef = useRef<ChatNavBridge>({});
  return (
    <StickToBottom
      className={cn("flex", className)}
      resize={resize}
      initial={initial}
      // 临界阻尼弹簧（每帧 v' = 0.8v + 0.01·差距；时间常数 ≈10 帧/170ms）：出字很快的模型每批渲染会一次塞进几行，
      // 库默认值（0.7/0.05/1.25，时间常数 ≈75ms）追得太利落，批与批之间就是一顿一顿；放缓后批间速度变化被抹平。
      // 代价是视口底部比最新文字滞后约 2 个时间常数，用户上滑/滚轮/选字仍会照常脱离跟随
      damping={0.8}
      stiffness={0.01}
      mass={1}
      contextRef={contextRef}
      role="log"
      {...props}
    >
      <ChatNavBridgeContext.Provider value={bridgeRef}>
        <AutoScrollController autoScroll={autoScroll} />
        {children}
        {navMessages ? <ChatMessageRail messages={navMessages} /> : null}
      </ChatNavBridgeContext.Provider>
    </StickToBottom>
  );
}

function ChatContainerContent({ children, className, style, ...props }: ChatContainerContentProps) {
  return (
    <StickToBottom.Content
      className={cn("flex w-full flex-col", className)}
      style={{ height: "auto", minHeight: "100%", overflow: "visible", ...style }}
      {...props}
    >
      {children}
    </StickToBottom.Content>
  );
}

function ChatContainerScrollAnchor({ className, ...props }: ChatContainerScrollAnchorProps) {
  return <div className={cn("h-px w-full shrink-0 scroll-mt-4", className)} aria-hidden="true" {...props} />;
}

export { ChatContainerRoot, ChatContainerContent, ChatContainerScrollAnchor };
