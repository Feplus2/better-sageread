import { cn } from "@/lib/utils";
import type * as React from "react";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "field-sizing-content flex min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-ring/50 ring-ring/10 transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:outline-1 focus-visible:ring-4 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive/60 aria-invalid:outline-destructive/60 aria-invalid:ring-destructive/20 aria-invalid:focus-visible:outline-none aria-invalid:focus-visible:ring-[3px] md:text-sm dark:outline-ring/40 dark:ring-ring/20 dark:aria-invalid:border-destructive dark:aria-invalid:outline-destructive dark:aria-invalid:ring-destructive/40 dark:aria-invalid:ring-destructive/50 dark:aria-invalid:focus-visible:ring-4",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
