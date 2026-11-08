"use client";

import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "lucide-react";
import type React from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Markdown } from "./markdown";

type ReasoningContextType = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
};

const ReasoningContext = createContext<ReasoningContextType | undefined>(undefined);

function useReasoningContext() {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("useReasoningContext must be used within a Reasoning provider");
  }
  return context;
}

export type ReasoningProps = {
  children: React.ReactNode;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};
// 默认折叠（含思考进行中）：展开与否完全由用户点击决定，不再随流式自动展开/收起
function Reasoning({ children, className, open, onOpenChange }: ReasoningProps) {
  const [internalOpen, setInternalOpen] = useState(false);

  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;

  const handleOpenChange = (newOpen: boolean) => {
    if (!isControlled) {
      setInternalOpen(newOpen);
    }
    onOpenChange?.(newOpen);
  };

  return (
    <ReasoningContext.Provider
      value={{
        isOpen,
        onOpenChange: handleOpenChange,
      }}
    >
      <div className={className}>{children}</div>
    </ReasoningContext.Provider>
  );
}

export type ReasoningTriggerProps = {
  children: React.ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLButtonElement>;

function ReasoningTrigger({ children, className, ...props }: ReasoningTriggerProps) {
  const { isOpen, onOpenChange } = useReasoningContext();

  return (
    <button
      type="button"
      aria-expanded={isOpen}
      className={cn("flex cursor-pointer items-center gap-2", className)}
      onClick={() => onOpenChange(!isOpen)}
      {...props}
    >
      <span className="text-primary">{children}</span>
      <div className={cn("transform transition-transform", isOpen ? "rotate-180" : "")}>
        <ChevronDownIcon className="size-4" />
      </div>
    </button>
  );
}

export type ReasoningContentProps = {
  children: React.ReactNode;
  className?: string;
  markdown?: boolean;
  contentClassName?: string;
} & React.HTMLAttributes<HTMLDivElement>;

function ReasoningContent({
  children,
  className,
  contentClassName,
  markdown = false,
  ...props
}: ReasoningContentProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const { isOpen, onOpenChange } = useReasoningContext();

  useEffect(() => {
    if (!contentRef.current || !innerRef.current) return;

    const observer = new ResizeObserver(() => {
      if (contentRef.current && innerRef.current && isOpen) {
        contentRef.current.style.maxHeight = `${innerRef.current.scrollHeight}px`;
      }
    });

    observer.observe(innerRef.current);

    if (isOpen) {
      contentRef.current.style.maxHeight = `${innerRef.current.scrollHeight}px`;
    }

    return () => observer.disconnect();
  }, [isOpen]);

  const content = markdown ? <Markdown>{children as string}</Markdown> : children;
  const collapseText = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isOpen || window.getSelection()?.toString()) return;
    if (
      event.target instanceof Element &&
      event.target.closest("a,button,input,textarea,select,summary,[role='button'],[contenteditable='true']")
    )
      return;
    onOpenChange(false);
  };

  return (
    <div
      ref={contentRef}
      className={cn("overflow-hidden transition-[max-height] duration-150 ease-out", className)}
      style={{
        maxHeight: isOpen ? contentRef.current?.scrollHeight : "0px",
      }}
      {...props}
    >
      <button
        type="button"
        tabIndex={isOpen ? 0 : -1}
        aria-expanded={isOpen}
        aria-label="收起思考内容"
        onClick={() => onOpenChange(false)}
        className="sr-only focus:not-sr-only focus:mb-1 focus:inline-flex focus:rounded-md focus:px-2 focus:py-1 focus:text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        收起思考内容
      </button>
      <div
        ref={innerRef}
        onClick={collapseText}
        className={cn(
          "prose prose-sm prose-neutral dark:prose-invert cursor-pointer text-muted-foreground",
          contentClassName,
        )}
      >
        {content}
      </div>
    </div>
  );
}

export { Reasoning, ReasoningTrigger, ReasoningContent };
