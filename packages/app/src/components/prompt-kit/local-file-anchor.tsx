import { classifyFileLink } from "@/ai/utils/local-file-link";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type ReactNode, createContext, useContext } from "react";

export const LocalFileLinkContext = createContext<((path: string) => void) | null>(null);

export function LocalFileAnchor({
  href,
  children,
  title,
}: {
  href?: string;
  children: ReactNode;
  title?: string;
}) {
  const onOpenLocalFile = useContext(LocalFileLinkContext);
  const link = classifyFileLink(href);
  if (link.kind === "blocked") return <span className="text-muted-foreground">{children}</span>;
  if (link.kind === "local" && onOpenLocalFile) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-local-file-path={link.path}
            onClick={() => onOpenLocalFile(link.path)}
            className="inline cursor-pointer text-left text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
          >
            {children}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{`在工作区打开：${link.path}`}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <a href={href} title={title}>
      {children}
    </a>
  );
}
