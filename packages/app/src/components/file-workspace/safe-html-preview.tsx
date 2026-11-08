import { useThemeStore } from "@/store/theme-store";
import { useMemo } from "react";

export interface SafeHtmlTheme {
  background: string;
  foreground: string;
  border: string;
}

const ACTIVE_ELEMENTS = "script,iframe,object,embed,link,base,form,meta,video,audio,source,track,svg,math,style";
const URL_ATTRIBUTES = new Set(["src", "href", "srcset", "action", "formaction", "poster", "background", "xlink:href"]);
const EXTERNAL_CSS = /(?:url\s*\(|@import\b|expression\s*\(|(?:java|vb)script\s*:)/i;

export function buildSafeHtmlSrcdoc(
  content: string,
  _theme: SafeHtmlTheme,
  options?: { allowScripts?: boolean },
): string {
  const allowScripts = options?.allowScripts === true;
  const parser = new DOMParser();
  const fullDocument = /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(content);
  const document = parser.parseFromString(
    fullDocument ? content : `<!doctype html><html><head></head><body>${content}</body></html>`,
    "text/html",
  );
  const activeSelector = allowScripts ? ACTIVE_ELEMENTS.replace("script,", "").replace(",style", "") : ACTIVE_ELEMENTS;
  document.querySelectorAll(activeSelector).forEach((element) => element.remove());
  if (allowScripts) {
    document.querySelectorAll("script").forEach((element) => {
      const type = element.getAttribute("type")?.trim().toLowerCase();
      if (element.hasAttribute("src") || type === "module" || type === "importmap") element.remove();
    });
    document.querySelectorAll("style").forEach((element) => {
      if (EXTERNAL_CSS.test(element.textContent ?? "")) element.remove();
    });
  }
  document.querySelectorAll("*").forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const localImage =
        allowScripts &&
        element.tagName === "IMG" &&
        name === "src" &&
        /^data:image\/(?:png|gif|jpeg|webp);base64,/i.test(attribute.value);
      if (name.startsWith("on") || (URL_ATTRIBUTES.has(name) && !localImage)) {
        element.removeAttribute(attribute.name);
      } else if (name === "style" && (!allowScripts || EXTERNAL_CSS.test(attribute.value))) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = allowScripts
    ? "default-src 'none'; script-src 'unsafe-inline'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; connect-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
    : "default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
  document.head.prepend(policy);
  const style = document.createElement("style");
  style.textContent = `html{background:#ffffff;color:#111111;color-scheme:light}*{box-sizing:border-box}body{margin:0;padding:16px;background:#ffffff;color:#111111;font:14px/1.65 "Noto Sans CJK SC","Microsoft YaHei UI","Segoe UI",sans-serif}h1,h2,h3,h4{line-height:1.4}p,li{line-height:1.75}table{border-collapse:collapse;width:100%;font-size:12px}caption{text-align:left;padding:6px 0;color:inherit}th,td{padding:6px 8px;border-bottom:1px solid #dddddd;text-align:left;vertical-align:top}th{background:#f5f5f5}a{color:inherit;text-decoration:none}pre{white-space:pre-wrap;word-break:break-word}`;
  policy.after(style);
  return document.documentElement.outerHTML;
}

export function SafeHtmlPreview({
  content,
  title,
  allowScripts = false,
}: { content: string; title: string; allowScripts?: boolean }) {
  const themeCode = useThemeStore((state) => state.themeCode);
  const isDarkMode = useThemeStore((state) => state.isDarkMode);
  // biome-ignore lint/correctness/useExhaustiveDependencies: themeCode/isDarkMode 在主题 CSS 变量改变后触发沙箱文档重建。
  const srcdoc = useMemo(() => {
    const computed = getComputedStyle(document.documentElement);
    return buildSafeHtmlSrcdoc(
      content,
      {
        background: computed.getPropertyValue("--background").trim() || "#fcfcfa",
        foreground: computed.getPropertyValue("--foreground").trim() || "#1d1d1d",
        border: computed.getPropertyValue("--border").trim() || "#e4e4e1",
      },
      { allowScripts },
    );
  }, [content, themeCode, isDarkMode, allowScripts]);
  const previewSrcdoc = useMemo(() => {
    if (!allowScripts) return srcdoc;
    const shell = document.implementation.createHTMLDocument(title);
    const policy = shell.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy";
    policy.content =
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    shell.head.appendChild(policy);
    const frame = shell.createElement("iframe");
    frame.title = `${title} 内容`;
    frame.setAttribute("sandbox", "allow-scripts");
    frame.referrerPolicy = "no-referrer";
    frame.srcdoc = srcdoc;
    frame.style.cssText = "display:block;width:100%;height:100%;border:0";
    shell.documentElement.style.height = "100%";
    shell.body.style.height = "100%";
    shell.body.style.margin = "0";
    shell.body.appendChild(frame);
    return shell.documentElement.outerHTML;
  }, [srcdoc, title, allowScripts]);
  return (
    <iframe
      title={title}
      srcDoc={previewSrcdoc}
      sandbox={allowScripts ? "allow-scripts" : ""}
      referrerPolicy="no-referrer"
      className="min-h-0 flex-1 border-0"
    />
  );
}
