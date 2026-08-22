/** katex auto-render 扩展的类型声明（katex 自带 types 未覆盖 contrib/auto-render 子路径导出） */
declare module "katex/contrib/auto-render" {
  import type { KatexOptions } from "katex";

  export interface RenderMathInElementDelimiter {
    /** 起始定界符（如 "$$"） */
    left: string;
    /** 结束定界符 */
    right: string;
    /** 是否按 display 模式渲染 */
    display: boolean;
  }

  export interface RenderMathInElementSpecificOptions {
    /** 要识别的定界符列表 */
    delimiters?: readonly RenderMathInElementDelimiter[];
    /** 递归时忽略的 DOM 节点类型 */
    ignoredTags?: ReadonlyArray<keyof HTMLElementTagNameMap>;
    /** 递归时忽略的 class 名 */
    ignoredClasses?: string[];
    /** 渲染关键错误回调 */
    errorCallback?: (msg: string, err: Error) => void;
  }

  export type RenderMathInElementOptions = KatexOptions & RenderMathInElementSpecificOptions;

  /** 在 HTML 元素内自动渲染 TeX 公式 */
  export default function renderMathInElement(elem: HTMLElement, options?: RenderMathInElementOptions): void;
}
