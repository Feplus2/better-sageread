/**
 * rehype 插件：把 <del> 还原为字面 "~~文本~~"。
 * 论文里 "~~" 是"约等于"的意思（如 ~~25 μm、~~10 nm），不存在删除线语义；
 * GFM 会把 ~~x~~ 解析成 <del>（删除线），渲染层还原为字面文本。
 */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
}

export function rehypeDelTilde() {
  return (tree: HastNode) => {
    const walk = (node: HastNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === "element" && child.tagName === "del") {
          return [
            { type: "text", value: "~~" },
            ...(child.children ?? []),
            { type: "text", value: "~~" },
          ];
        }
        walk(child);
        return [child];
      });
    };
    walk(tree);
  };
}
