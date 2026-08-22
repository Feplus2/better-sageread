/**
 * 自包含 KaTeX 样式：katex.min.css 的 @font-face 字体引用全部替换为 woff2 data URI。
 * 仅供论文导出（HTML/PDF 打印页）使用，经动态 import 按需加载（字体 base64 约 400KB，不进主 chunk）。
 */

import fontAms from "katex/dist/fonts/KaTeX_AMS-Regular.woff2?inline";
import fontCaligraphicBold from "katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2?inline";
import fontCaligraphic from "katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2?inline";
import fontFrakturBold from "katex/dist/fonts/KaTeX_Fraktur-Bold.woff2?inline";
import fontFraktur from "katex/dist/fonts/KaTeX_Fraktur-Regular.woff2?inline";
import fontMainBold from "katex/dist/fonts/KaTeX_Main-Bold.woff2?inline";
import fontMainBoldItalic from "katex/dist/fonts/KaTeX_Main-BoldItalic.woff2?inline";
import fontMainItalic from "katex/dist/fonts/KaTeX_Main-Italic.woff2?inline";
import fontMain from "katex/dist/fonts/KaTeX_Main-Regular.woff2?inline";
import fontMathBoldItalic from "katex/dist/fonts/KaTeX_Math-BoldItalic.woff2?inline";
import fontMathItalic from "katex/dist/fonts/KaTeX_Math-Italic.woff2?inline";
import fontSansSerifBold from "katex/dist/fonts/KaTeX_SansSerif-Bold.woff2?inline";
import fontSansSerifItalic from "katex/dist/fonts/KaTeX_SansSerif-Italic.woff2?inline";
import fontSansSerif from "katex/dist/fonts/KaTeX_SansSerif-Regular.woff2?inline";
import fontScript from "katex/dist/fonts/KaTeX_Script-Regular.woff2?inline";
import fontSize1 from "katex/dist/fonts/KaTeX_Size1-Regular.woff2?inline";
import fontSize2 from "katex/dist/fonts/KaTeX_Size2-Regular.woff2?inline";
import fontSize3 from "katex/dist/fonts/KaTeX_Size3-Regular.woff2?inline";
import fontSize4 from "katex/dist/fonts/KaTeX_Size4-Regular.woff2?inline";
import fontTypewriter from "katex/dist/fonts/KaTeX_Typewriter-Regular.woff2?inline";
import cssText from "katex/dist/katex.min.css?raw";

const FONT_DATA_URIS: Record<string, string> = {
  "KaTeX_AMS-Regular.woff2": fontAms,
  "KaTeX_Caligraphic-Bold.woff2": fontCaligraphicBold,
  "KaTeX_Caligraphic-Regular.woff2": fontCaligraphic,
  "KaTeX_Fraktur-Bold.woff2": fontFrakturBold,
  "KaTeX_Fraktur-Regular.woff2": fontFraktur,
  "KaTeX_Main-Bold.woff2": fontMainBold,
  "KaTeX_Main-BoldItalic.woff2": fontMainBoldItalic,
  "KaTeX_Main-Italic.woff2": fontMainItalic,
  "KaTeX_Main-Regular.woff2": fontMain,
  "KaTeX_Math-BoldItalic.woff2": fontMathBoldItalic,
  "KaTeX_Math-Italic.woff2": fontMathItalic,
  "KaTeX_SansSerif-Bold.woff2": fontSansSerifBold,
  "KaTeX_SansSerif-Italic.woff2": fontSansSerifItalic,
  "KaTeX_SansSerif-Regular.woff2": fontSansSerif,
  "KaTeX_Script-Regular.woff2": fontScript,
  "KaTeX_Size1-Regular.woff2": fontSize1,
  "KaTeX_Size2-Regular.woff2": fontSize2,
  "KaTeX_Size3-Regular.woff2": fontSize3,
  "KaTeX_Size4-Regular.woff2": fontSize4,
  "KaTeX_Typewriter-Regular.woff2": fontTypewriter,
};

/** katex.min.css 的字体声明：url(fonts/X.woff2) format("woff2"),url(...woff) ...,url(...ttf) ... → 单个 woff2 data URI */
const FONT_SRC_RE =
  /url\(fonts\/([\w-]+\.woff2)\) format\("woff2"\),url\(fonts\/[\w-]+\.woff\) format\("woff"\),url\(fonts\/[\w-]+\.ttf\) format\("truetype"\)/g;

/** 返回字体全内联的 KaTeX 样式文本（重复调用便宜：replace 纯函数） */
export function buildInlineKatexCss(): string {
  return cssText.replace(FONT_SRC_RE, (match, name: string) => {
    const dataUri = FONT_DATA_URIS[name];
    return dataUri ? `url(${dataUri}) format("woff2")` : match;
  });
}
