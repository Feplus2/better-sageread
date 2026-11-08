import { MarkdownPreview } from "@/components/preview/markdown-preview";
import { type AgentFileScope, readWorkspaceImage } from "@/services/agent-workspace-files";
import { useEffect, useMemo, useState } from "react";
import type { Components } from "react-markdown";

function isBlockedResource(value: string | undefined): boolean {
  if (!value) return false;
  return (
    /^(?:asset|file|tauri|ms-appx|ms-appx-web|ms-appdata|blob|javascript|vbscript):/i.test(value) ||
    /^(?:https?:)?\/\/asset\.localhost(?:\/|$)/i.test(value)
  );
}

function WorkspaceResourceImage({
  scope,
  sourcePath,
  rootResolved,
  src,
  alt,
  title,
}: {
  scope: AgentFileScope;
  sourcePath: string;
  rootResolved: string;
  src?: string;
  alt?: string;
  title?: string;
}) {
  const [state, setState] = useState<{ url: string; blocked: boolean }>({ url: "", blocked: false });
  useEffect(() => {
    let active = true;
    setState({ url: "", blocked: false });
    const resolve = async () => {
      if (!src || isBlockedResource(src)) {
        if (active) setState({ url: "", blocked: true });
        return;
      }
      if (/^https?:\/\//i.test(src) || src.startsWith("data:image/")) {
        if (active) setState({ url: src, blocked: false });
        return;
      }
      try {
        const decoded = decodeURIComponent(src);
        const base = sourcePath.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
        const absolute = /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(decoded);
        const path = absolute ? decoded : base ? `${base}/${decoded}` : decoded;
        const image = await readWorkspaceImage(scope, path, { rootResolved });
        if (active) setState({ url: image.dataUrl, blocked: false });
      } catch {
        if (active) setState({ url: "", blocked: true });
      }
    };
    void resolve();
    return () => {
      active = false;
    };
  }, [scope, sourcePath, rootResolved, src]);

  if (state.blocked) return <span className="text-neutral-500 text-xs">本地或敏感图片已阻止</span>;
  if (!state.url) return <span className="text-neutral-400 text-xs">读取图片…</span>;
  return <img src={state.url} alt={alt ?? "工作区图片"} title={title} />;
}

export function WorkspaceMarkdown({
  scope,
  sourcePath,
  rootResolved,
  content,
}: {
  scope: AgentFileScope;
  sourcePath: string;
  rootResolved: string;
  content: string;
}) {
  const components = useMemo<Partial<Components>>(
    () => ({
      img: ({ src, alt, title }) => (
        <WorkspaceResourceImage
          scope={scope}
          sourcePath={sourcePath}
          rootResolved={rootResolved}
          src={src}
          alt={alt}
          title={title}
        />
      ),
      a: ({ href, children }) => {
        if (isBlockedResource(href) || href?.startsWith("data:")) {
          return <span className="text-neutral-500 text-xs">{children}（本地资源链接已阻止）</span>;
        }
        if (href && !/^https?:\/\//i.test(href)) {
          return <span className="text-neutral-500 text-xs">{children}（本地资源链接已阻止）</span>;
        }
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      },
    }),
    [scope, sourcePath, rootResolved],
  );
  return <MarkdownPreview content={content} components={components} />;
}
