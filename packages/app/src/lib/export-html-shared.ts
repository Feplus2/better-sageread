/**
 * 导出 HTML 共享件：对话导出（export-thread-html）与论文导出（export-paper）共用。
 * 独立成模块以避免论文导出经由对话导出拖入 book-service → foliate-js 依赖链。
 */

/**
 * 轻量净化：去掉 script/iframe 等危险标签、on* 事件属性和 javascript: 链接。
 * 项目无 DOMPurify 类依赖，此为正则级防护，内容来自用户自己的对话记录，威胁模型有限。
 */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<(script|iframe|object|embed|form|link|meta|style)\b[\s\S]*?(<\/\s*\1\s*>|\/?>)/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'>]*\2/gi, "$1=$2#$2");
}

/**
 * 导出文档的共享样式（HTML 导出与图片导出共用，单一事实源）
 */
export const EXPORT_HTML_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 16px; background: #f5f1e8; color: #3a3226;
         font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.7; }
  .container { max-width: 760px; margin: 0 auto; }
  header { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #ddd3b8; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  .meta { font-size: 13px; color: #8a7c60; }
  .meta span + span::before { content: " · "; }
  .message { margin-bottom: 16px; display: flex; flex-direction: column; }
  .message.user { align-items: flex-end; }
  .message.assistant { align-items: flex-start; }
  .role { font-size: 12px; color: #8a7c60; margin-bottom: 4px; padding: 0 4px; }
  .bubble { max-width: 88%; padding: 12px 16px; border-radius: 12px; box-shadow: 0 1px 3px rgba(60, 50, 30, 0.08); }
  .user .bubble { background: #e9d6a6; border-radius: 12px 12px 4px 12px; }
  .assistant .bubble { background: #fffdf7; border: 1px solid #e5dcc4; border-radius: 12px 12px 12px 4px; }
  .bubble > :first-child { margin-top: 0; }
  .bubble > :last-child { margin-bottom: 0; }
  blockquote { margin: 8px 0; padding: 4px 12px; border-left: 3px solid #a05a2c;
               background: rgba(160, 90, 44, 0.07); color: #6b5c42; border-radius: 0 6px 6px 0; }
  pre { background: #3a2e1e; color: #f0e6d0; padding: 12px 14px; border-radius: 8px; overflow-x: auto; font-size: 13px; }
  code { font-family: Consolas, "Courier New", monospace; }
  p code, li code { background: rgba(160, 90, 44, 0.1); padding: 1px 5px; border-radius: 4px; font-size: 90%; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; margin: 8px 0; }
  th, td { border: 1px solid #ddd3b8; padding: 6px 10px; }
  th { background: #eee2c2; }
  img { max-width: 100%; }
  a { color: #a05a2c; }
  footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid #ddd3b8;
           font-size: 12px; color: #8a7c60; text-align: center; }
`;
