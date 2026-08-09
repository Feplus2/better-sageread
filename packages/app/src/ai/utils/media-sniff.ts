/**
 * J2 补环：从 dataUrl 的 base64 魔数嗅探真实图片类型。
 *
 * 背景：论文插图引用链路上，asset 协议/本地服务器 fetch 出的 Blob.type 可能是空串
 * 甚至 text/plain，直接采用会让 file part 以 text/plain 下发，多模态端点拒收
 * （'file part media type text/plain' functionality not supported）。
 * 魔数嗅探只认图片家族；认不出的返回 null（调用方保留原值）。
 */
export function sniffImageMediaType(dataUrl: string): string | null {
  const m = /^data:[^,]*;base64,(.{16})/.exec(dataUrl);
  if (!m) return null;
  const head = m[1];
  if (head.startsWith("/9j/")) return "image/jpeg";
  if (head.startsWith("iVBOR")) return "image/png";
  if (head.startsWith("R0lGOD")) return "image/gif";
  if (head.startsWith("UklGR")) return "image/webp";
  return null;
}

/**
 * 修复 dataUrl 的 MIME 前缀：部分提供商/转换器按 dataUrl 头（而非 mediaType 字段）判定类型，
 * 仅改 mediaType 字段不够，需同步把 `data:text/plain;base64,` 这类错误前缀改为真实类型。
 * 嗅探失败时原样返回。
 */
export function repairImageDataUrl(dataUrl: string): string {
  const sniffed = sniffImageMediaType(dataUrl);
  if (!sniffed) return dataUrl;
  // 已是正确前缀则不动；否则替换 MIME 段（保留 base64 负载）
  return dataUrl.replace(/^data:[^;,]*(;base64,)/i, `data:${sniffed}$1`);
}
