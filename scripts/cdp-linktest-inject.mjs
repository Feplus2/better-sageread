// 临时往 dev 实例论文 paper.md 注入合成锚点/链接（验证后由 cdp-link-restore 恢复）
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const file = "C:/Users/20995/AppData/Roaming/com.bettersageread.dev/books/6c533ac14d2b48e4/paper.md";
const backup = `${file}.linktest-backup`;
copyFileSync(file, backup);

let md = readFileSync(file, "utf8");
const replaceOnce = (from, to) => {
  const count = md.split(from).length - 1;
  if (count !== 1) throw new Error(`替换目标不唯一或不存在 (${count}): ${from.slice(0, 60)}`);
  md = md.replace(from, to);
};

// 正文链接：ref-1（锚点存在）、ref-5（锚点不存在→quote 兜底）、ref-99（锚点与文本都没有→静默）
replaceOnce("with $A \\simeq 3/2$ [1].", "with $A \\simeq 3/2$ [[1]](#ref-1) [[5]](#ref-5) [[99]](#ref-99).");
// 正文链接：Fig. 10（锚点存在）
replaceOnce("as illustrated in Fig. 6,", "as illustrated in [Fig. 10](#fig-10),");
// 参考文献条目锚点
replaceOnce("[1] S. Mukovnikov and L. Sousa,", '<a id="ref-1"></a>[1] S. Mukovnikov and L. Sousa,');
replaceOnce("[2] N. Aggarwal et al., Challenges", '<a id="ref-2"></a>[2] N. Aggarwal et al., Challenges');
replaceOnce("[12] J. J. Blanco-Pillado,", '<a id="ref-12"></a>[12] J. J. Blanco-Pillado,');
// 图块锚点（图注段首）
replaceOnce("Figure 10: Analytical approximation", '<a id="fig-10"></a>Figure 10: Analytical approximation');

writeFileSync(file, md);
console.log("injected, backup at", backup);
