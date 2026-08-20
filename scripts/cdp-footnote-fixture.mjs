// 脚注测试夹具：备份 57ae0a5f 的 paper.md → 把 3 条 $^{N}$ 脚注转为 Pandoc 契约形态（[^N] 引用点 +
// [^N]: 定义集中在 References 之前）+ 1 条无引用点定义（降级形态）；restore 还原。
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const FILE = "C:/Users/20995/AppData/Roaming/com.bettersageread.dev/books/57ae0a5f29feecb6/paper.md";
const BK = "C:/Users/20995/AppData/Local/Temp/footnote-test-backup-57ae0a5f.md";
const mode = process.argv[2] ?? "install";

if (mode === "restore") {
  if (!existsSync(BK)) throw new Error("无备份可恢复");
  copyFileSync(BK, FILE);
  rmSync(BK);
  console.log("已恢复原 paper.md");
  process.exit(0);
}

copyFileSync(FILE, BK);
let md = readFileSync(FILE, "utf8");
const replaceOnce = (from, to) => {
  if (!md.includes(from)) throw new Error(`未找到替换目标: ${from.slice(0, 70)}`);
  md = md.replace(from, to);
};

// 1) 正文引用点：$^{N}$ → [^N]
replaceOnce("cusps on loops. $^{1}$ A cusp is", "cusps on loops.[^1] A cusp is");
replaceOnce("as the GW background. $^{4}$", "as the GW background.[^4]");
replaceOnce("the degeneracies are broken. $^{6}$", "the degeneracies are broken.[^6]");

// 2) 三条定义段从原位取出（整段删除），内容转为 [^N]: 定义
const defs = [];
for (const n of [1, 4, 6]) {
  const re = new RegExp(`\\n\\$\\^\\{${n}\\}\\$ ([^\\n]+(?:\\n(?!\\n)[^\\n]+)*)`);
  const m = md.match(re);
  if (!m) throw new Error(`未找到脚注 ${n} 的定义段`);
  defs.push(`[^${n}]: ${m[1]}`);
  md = md.replace(m[0], "");
}

// 3) 定义集中放到 References 之前（契约形态），另加一条无引用点的降级定义
const block = `${defs.join("\n\n")}\n\n[^9]: This footnote has no reference point in the body text (degraded form should still render in the footnote area).\n\n# References`;
replaceOnce("# References", block);

writeFileSync(FILE, md);
console.log("夹具已安装：3 条契约脚注 + 1 条降级定义");
