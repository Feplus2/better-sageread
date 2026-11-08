"use client";

import { cn } from "@/lib/utils";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type * as React from "react";

function TooltipProvider({ delayDuration = 150, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />;
}

// disableHoverableContent 默认开：指针离开触发器即关闭。Radix 默认（可悬停内容）下，离开触发器只清定时器、
// 真正的关闭要靠"宽容区 pointermove 追踪"——该链路任一环断开，提示就悬住，直到点空白处/滚动才消失。
// 需要把鼠标移进提示里选字的少数点位显式传 disableHoverableContent={false}。
// delayDuration 0 → 150ms：鼠标只是扫过工具栏时不再逐个闪出提示。
function Tooltip({ disableHoverableContent = true, ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" disableHoverableContent={disableHoverableContent} {...props} />
    </TooltipProvider>
  );
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 4,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "fade-in-0 zoom-in-95 data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-w-sm animate-in rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-xs data-[state=closed]:pointer-events-none data-[state=closed]:animate-out",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-primary fill-primary" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
