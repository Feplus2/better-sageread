// parseBatchResponse 反斜杠修复的隔离微测（与 paper-translation-service.ts 同款逻辑）
const repair = (s) => s.replace(/\\(?:[\\/"bfnrtu]|u[0-9a-fA-F]{4})|\\/g, (m) => (m.length > 1 ? m : "\\\\"));

// 病例：LaTeX 密集批次，模型把 \vartheta 写成单反斜杠（\v 是非法 JSON 转义，原流程必炸）
const bad = `[{"index":45,"text":"其中 $\\vartheta = t_{f}$ 与 $\\bar{v}$ 演化"},{"index":46,"text":"plain"}]`;
let threw = false;
try {
  JSON.parse(bad);
} catch {
  threw = true;
}
console.log("病例 原样解析抛错(预期 true):", threw);
const parsed = JSON.parse(repair(bad));
console.log("病例 修复后解析 OK:", parsed.length === 2, "| text 含 \\vartheta:", parsed[0].text.includes("\\vartheta"));

// 对照：用 JSON.stringify 造合法输出（含 LaTeX 反斜杠、换行、引号、\u 转义），修复必须幂等
const obj = [{ index: 1, text: "a\\vartheta b\nc\"d $\\bar{v}$ A \\ \t end\\" }];
const good = JSON.stringify(obj);
console.log("对照 原样可解析:", JSON.parse(good)[0].text === obj[0].text);
console.log("对照 修复幂等(内容不变):", JSON.parse(repair(good))[0].text === obj[0].text);

// 混合场景：模型一半写对（\\mu）一半写错（\mu）
const mixed = `[{"index":2,"text":"$\\\\mu$ 与 $\\mu$"}]`;
console.log("混合 修复后两个 \\mu 都在:", JSON.parse(repair(mixed))[0].text === "$\\mu$ 与 $\\mu$");

// 已知边界：末尾落单反斜杠吃掉闭引号（"abc\"}）属于结构性歧义，正则救不了——
// 该场景继续走既有的严格措辞重试/跳过兜底，修复器不背锅
