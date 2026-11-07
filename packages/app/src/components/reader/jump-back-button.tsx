import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface JumpBackButtonProps {
  onClick: () => void;
}

export function JumpBackButton({ onClick }: JumpBackButtonProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const clearCloseTimer = () => window.clearTimeout(closeTimer.current);
  const scheduleClose = () => {
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => {
      if (document.activeElement !== buttonRef.current) setOpen(false);
    }, 150);
  };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  return (
    <div className="pointer-events-none absolute right-4 bottom-4 z-20">
      <Tooltip open={open} onOpenChange={setOpen} disableHoverableContent={false}>
        <TooltipTrigger asChild>
          <button
            ref={buttonRef}
            type="button"
            aria-label="返回转跳前位置"
            className="pointer-events-auto flex size-9 items-center justify-center rounded-full border bg-popover text-popover-foreground shadow-around transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            onPointerEnter={clearCloseTimer}
            onPointerLeave={scheduleClose}
            onFocus={clearCloseTimer}
            onBlur={() => setOpen(false)}
            onClick={(event) => {
              event.stopPropagation();
              setOpen(false);
              onClick();
            }}
          >
            <Undo2 aria-hidden="true" className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" align="end" onPointerEnter={clearCloseTimer} onPointerLeave={scheduleClose}>
          返回转跳前位置
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
