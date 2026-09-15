/**
 * rehype 插件（排在 rehype-katex 之前）：remark-math 产出的 math 容器
 * （class 含 math / math-inline / math-display）此刻还是【源码文本】，
 * 先把源码收进 data-latex——rehype-katex 随后替换 children 渲染，
 * 元素属性保留，源码随 DOM 存留。
 * 用途：划词引用公式时回解精确 LaTeX（Agent 内容保真）。
 */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: string[] | string; dataLatex?: string; [k: string]: unknown };
  children?: HastNode[];
}

const textOf = (node: HastNode): string =>
  (node.children ?? []).map((c) => (c.type === "text" ? (c.value ?? "") : textOf(c))).join("");

export function rehypeMathSourceAttr() {
  return (tree: HastNode) => {
    const walk = (node: HastNode) => {
      if (node.type === "element") {
        const cls = node.properties?.className;
        const classes = Array.isArray(cls) ? cls : typeof cls === "string" ? cls.split(/\s+/) : [];
        if (classes.includes("math") || classes.includes("math-inline") || classes.includes("math-display")) {
          if (!node.properties?.dataLatex) {
            const tex = textOf(node).trim();
            if (tex) node.properties = { ...node.properties, dataLatex: tex };
          }
        }
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}
