// 只认纯数字方括号（chunk id 引用标）；[5.98 所在引文] 这类模型随手写的描述性方括号
// 此前也会被吞成引用 chip，点击后 chunkId 非整数必报"无效的引用标记"
export function parseAnnotations(text: string): (string | { type: "annotation"; number: string })[] {
  const annotationRegex = /\[(\d+)\]/g;
  const parts: (string | { type: "annotation"; number: string })[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  match = annotationRegex.exec(text);
  while (match !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    parts.push({
      type: "annotation",
      number: match[1],
    });

    lastIndex = match.index + match[0].length;

    match = annotationRegex.exec(text);
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}
