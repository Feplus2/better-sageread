import { useEffectiveMotionMode } from "@/hooks/use-motion-mode";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion } from "framer-motion";
import type { ReactNode } from "react";

const PANEL_EASE = [0.4, 0, 0.6, 1] as const;

interface AssistantPanelTransitionProps {
  present: boolean;
  children: ReactNode;
  side?: "left" | "right";
  className?: string;
  onBackdropClick?: () => void;
}

export function AssistantPanelTransition({
  present,
  children,
  side = "right",
  className,
  onBackdropClick,
}: AssistantPanelTransitionProps) {
  const motionMode = useEffectiveMotionMode();
  const reduced = motionMode === "reduced";
  const fadeOnly = motionMode === "fade-only";
  const hidden = fadeOnly ? { opacity: 0 } : { opacity: 0, x: side === "left" ? "-100%" : "100%" };
  const visible = fadeOnly ? { opacity: 1 } : { opacity: 1, x: 0 };
  return (
    <div
      className={cn("pointer-events-none absolute inset-0", side === "left" ? "z-50" : "z-20")}
      inert={!present}
      aria-hidden={!present}
    >
      {onBackdropClick && present && (
        <div
          className="pointer-events-auto absolute inset-x-0 top-10 bottom-0"
          aria-hidden="true"
          onClick={onBackdropClick}
        />
      )}
      <AnimatePresence initial={false}>
        {present && (
          <motion.div
            data-panel-side={side}
            className={cn("pointer-events-auto absolute inset-0 flex min-h-0 flex-col bg-popover", className)}
            initial={reduced ? { opacity: 0 } : hidden}
            animate={reduced ? { opacity: 1 } : visible}
            exit={reduced ? { opacity: 0 } : hidden}
            transition={{ duration: reduced ? 0 : fadeOnly ? 0.08 : 0.2, ease: PANEL_EASE }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
