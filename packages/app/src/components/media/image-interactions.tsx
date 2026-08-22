import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { iframeService } from "@/services/iframe-service";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { Copy, Download, Quote, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * 图片交互统一层（T3+T4，2026-08-22）：
 * - 右键菜单（主题化，替代 WebView 原生菜单）：复制图片 / 图片另存为 / 引用到对话
 * - 可选点击大图预览（书籍侧启用；论文侧 per-img 自带预览，仅挂右键）
 * 书籍内容在 foliate 的 shadow DOM 里——contextmenu/click 为 composed 事件，
 * 宿主容器 capture 监听即可拦截（e.composedPath 找 img）。
 */

interface TargetImage {
  src: string;
  alt: string;
}

async function fetchBlob(src: string): Promise<Blob> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`读取图片失败（HTTP ${res.status}）`);
  return res.blob();
}

async function copyImage(src: string): Promise<void> {
  const blob = await fetchBlob(src);
  await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
}

async function saveImage(src: string, alt: string): Promise<void> {
  const blob = await fetchBlob(src);
  const base =
    alt
      .replace(/[\\/:*?"<>|]/g, "_")
      .slice(0, 60)
      .trim() || "image";
  const ext = blob.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  const path = await save({
    defaultPath: `${base}.${ext}`,
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
  });
  if (!path) return;
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
}

async function toDataUrl(src: string): Promise<{ dataUrl: string; mediaType: string }> {
  const blob = await fetchBlob(src);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(blob);
  });
  return { dataUrl, mediaType: blob.type || "image/png" };
}

/** 主题化右键菜单（光标定位，点击外部/Esc 关闭；菜单项动作见 ImageInteractions） */
function ContextPopupMenu({
  pos,
  image,
  onQuote,
  onClose,
}: {
  pos: { x: number; y: number };
  image: TargetImage;
  onQuote?: (image: { dataUrl: string; mediaType: string; name: string }) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // 延迟绑定避免打开菜单的那次点击立即关闭
    const timer = window.setTimeout(() => {
      document.addEventListener("mousedown", close);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const run = async (action: "copy" | "save" | "quote") => {
    onClose();
    try {
      if (action === "copy") {
        await copyImage(image.src);
        toast.success("图片已复制到剪贴板");
      } else if (action === "save") {
        await saveImage(image.src, image.alt);
        toast.success("图片已保存");
      } else {
        const { dataUrl, mediaType } = await toDataUrl(image.src);
        onQuote?.({ dataUrl, mediaType, name: image.alt || "图片" });
        toast.success("已引用到对话输入区");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  // 视口边缘防溢出：右/下越界时向左/上翻
  const style: React.CSSProperties = {
    left: Math.min(pos.x, window.innerWidth - 190),
    top: Math.min(pos.y, window.innerHeight - 150),
  };

  return (
    <div
      ref={ref}
      style={style}
      className="fixed z-[110] min-w-44 overflow-hidden rounded-md border border-neutral-200 bg-background p-1 shadow-lg dark:border-neutral-700"
      role="menu"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
        onClick={() => void run("copy")}
      >
        <Copy className="size-4 text-neutral-500" /> 复制图片
      </button>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
        onClick={() => void run("save")}
      >
        <Download className="size-4 text-neutral-500" /> 图片另存为…
      </button>
      {onQuote && (
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
          onClick={() => void run("quote")}
        >
          <Quote className="size-4 text-neutral-500" /> 引用到对话
        </button>
      )}
    </div>
  );
}

/** 点击大图预览（居中放大 + 复制/保存/引用/关闭；Esc 与背板关闭）——书籍侧与论文侧共用形态 */
export function ImagePreviewOverlay({
  image,
  onClose,
  onQuote,
}: {
  image: TargetImage;
  onClose: () => void;
  onQuote?: (image: { dataUrl: string; mediaType: string; name: string }) => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (action: "copy" | "save" | "quote") => {
    try {
      if (action === "copy") {
        await copyImage(image.src);
        toast.success("图片已复制到剪贴板");
      } else if (action === "save") {
        await saveImage(image.src, image.alt);
        toast.success("图片已保存");
      } else {
        const { dataUrl, mediaType } = await toDataUrl(image.src);
        onQuote?.({ dataUrl, mediaType, name: image.alt || "figure" });
        toast.success("已引用到对话输入区");
        onClose();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div className="absolute top-4 right-4 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        {[
          { action: "copy" as const, label: "复制", icon: <Copy className="size-4" /> },
          { action: "save" as const, label: "保存", icon: <Download className="size-4" /> },
          ...(onQuote ? [{ action: "quote" as const, label: "引用", icon: <Quote className="size-4" /> }] : []),
        ].map(({ action, label, icon }) => (
          <Button
            key={action}
            type="button"
            variant="ghost"
            className="bg-white/10 text-white hover:bg-white/20"
            onClick={() => void run(action)}
          >
            {icon}
            {label}
          </Button>
        ))}
        <Button type="button" variant="ghost" className="bg-white/10 text-white hover:bg-white/20" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="max-h-[88vh] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <img src={image.src} alt={image.alt} className="max-h-[88vh] max-w-[92vw] object-contain" />
      </div>
    </div>
  );
}

/**
 * 挂在阅读容器上：img 右键 → 主题菜单（替代原生）；可选 img 点击 → 大图预览。
 * onQuote 提供时菜单/预览带“引用”项。
 */
export function ImageInteractions({
  containerRef,
  enableClickPreview = false,
  onQuote,
  className,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  enableClickPreview?: boolean;
  onQuote?: (image: { dataUrl: string; mediaType: string; name: string }) => void;
  className?: string;
}) {
  const [menu, setMenu] = useState<{ pos: { x: number; y: number }; image: TargetImage } | null>(null);
  const [preview, setPreview] = useState<TargetImage | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const imageFromEvent = (e: Event): TargetImage | null => {
      const path = e.composedPath?.() ?? [];
      for (const node of path) {
        if (node instanceof HTMLImageElement) {
          return { src: node.src, alt: node.alt ?? "" };
        }
        if (node instanceof Element && node.tagName === "IMG" && "src" in node) {
          return { src: String((node as HTMLImageElement).src), alt: node.getAttribute("alt") ?? "" };
        }
      }
      return null;
    };

    const onContextMenu = (e: MouseEvent) => {
      const image = imageFromEvent(e);
      if (!image) return;
      e.preventDefault();
      e.stopPropagation();
      setMenu({ pos: { x: e.clientX, y: e.clientY }, image });
    };
    const onClick = (e: MouseEvent) => {
      if (!enableClickPreview) return;
      const image = imageFromEvent(e);
      if (!image) return;
      e.preventDefault();
      e.stopPropagation();
      setPreview(image);
    };

    container.addEventListener("contextmenu", onContextMenu, true);
    if (enableClickPreview) {
      container.addEventListener("click", onClick, true);
    }
    return () => {
      container.removeEventListener("contextmenu", onContextMenu, true);
      if (enableClickPreview) {
        container.removeEventListener("click", onClick, true);
      }
    };
  }, [containerRef, enableClickPreview]);

  return (
    <>
      {menu && <ContextPopupMenu pos={menu.pos} image={menu.image} onQuote={onQuote} onClose={() => setMenu(null)} />}
      {preview && <ImagePreviewOverlay image={preview} onClose={() => setPreview(null)} onQuote={onQuote} />}
      {/* 常驻空占位避免影响布局；className 仅用于调试钩子 */}
      <span className={cn("hidden", className)} data-image-interactions="" />
    </>
  );
}

/** 便捷工厂：引用动作直连 iframeService（书籍=reader 面板 / 论文=paper 面板，按 bookId 路由） */
export function quoteImageToChat(bookId?: string) {
  return (image: { dataUrl: string; mediaType: string; name: string }) => {
    iframeService.sendImageReferenceRequest(image, bookId);
  };
}
