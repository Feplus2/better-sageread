// P2 卡片验证夹具：备份原 paper.md/images → 换入 P1 转换产物 → 对齐 ref-40/42 为合成在库条目 → 写样例 references.json
import { copyFileSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const BOOK = "C:/Users/20995/AppData/Roaming/com.bettersageread.dev/books/6c533ac14d2b48e4";
const SRC = "F:/MyProjects/Papers_Converter/output_links_ab/cosmic/default/mukovnikovgravitational";
const BK = "C:/Users/20995/AppData/Local/Temp/p2-card-backup-6c533ac14d2b48e4";

const mode = process.argv[2] ?? "install";

if (mode === "install") {
  rmSync(BK, { recursive: true, force: true });
  cpSync(`${BOOK}/images`, `${BK}/images`, { recursive: true });
  copyFileSync(`${BOOK}/paper.md`, `${BK}/paper.md`);

  copyFileSync(`${SRC}/paper.md`, `${BOOK}/paper.md`);
  rmSync(`${BOOK}/images`, { recursive: true, force: true });
  cpSync(`${SRC}/images`, `${BOOK}/images`, { recursive: true });

  // 对齐两条合成在库条目（自驾驶实验室论文，库内 e5a687053a59c277）
  let md = readFileSync(`${BOOK}/paper.md`, "utf8");
  const replaceOnce = (from, to) => {
    if (!md.includes(from)) throw new Error(`未找到待替换行: ${from.slice(0, 60)}`);
    md = md.replace(from, to);
  };
  replaceOnce(
    '<a id="ref-40"></a>[40] B. Allen, P. Casper, and A. Ottewill, Analytic results for the gravitational radiation from a class of cosmic string loops, [Phys. Rev. D 50, 3703 (1994](https://doi.org/10.1103/PhysRevD.50.3703)), arXiv:gr-qc/9405037.',
    '<a id="ref-40"></a>[40] M. Bjornsson et al., The rise of self-driving labs in chemical and materials sciences, [Nat. Synth. 2, 483 (2023](https://doi.org/10.1038/s44160-022-00231-0)).',
  );
  replaceOnce(
    '<a id="ref-42"></a>[42] J. J. Blanco-Pillado, K. D. Olum, and B. Shlaer, Cosmic string loop shapes, [Phys. Rev. D 92, 063528 (2015](https://doi.org/10.1103/PhysRevD.92.063528)), [arXiv:1508.02693 [astro-ph.CO]](https://arxiv.org/abs/1508.02693).',
    '<a id="ref-42"></a>[42] M. Bjornsson et al., The rise of self-driving labs in chemical and materials sciences, Nature Synthesis (2023).',
  );
  writeFileSync(`${BOOK}/paper.md`, md);

  const references = [
    {
      n: 1,
      raw: "[1] S. Mukovnikov and L. Sousa, Ultrahigh frequency gravitational waves from cosmic strings with friction, Phys. Rev. D 110, 063516 (2024), arXiv:2404.13213 [astro-ph.CO].",
      title: "Ultrahigh frequency gravitational waves from cosmic strings with friction",
      authors: ["S. Mukovnikov", "L. Sousa"],
      year: "2024",
      venue: "Phys. Rev. D 110, 063516",
      doi: "10.1103/PhysRevD.110.063516",
    },
    {
      n: 2,
      raw: "[2] N. Aggarwal et al., Challenges and opportunities of gravitational-wave searches at MHz to GHz frequencies, Living Rev. Rel. 24, 4 (2021), arXiv:2011.12414 [gr-qc].",
      title: "Challenges and opportunities of gravitational-wave searches at MHz to GHz frequencies",
      authors: ["N. Aggarwal", "et al."],
      year: "2021",
      venue: "Living Rev. Rel. 24, 4",
      doi: "10.1007/s41114-021-00032-5",
    },
    {
      n: 4,
      raw: "[4] M. B. Hindmarsh and T. W. B. Kibble, Cosmic strings, Reports on Progress in Physics 58, 477 (1995).",
      title: "Cosmic strings",
      authors: ["M. B. Hindmarsh", "T. W. B. Kibble"],
      year: "1995",
      venue: "Reports on Progress in Physics 58, 477",
      doi: "10.1088/0034-4885/58/5/001",
    },
    {
      n: 5,
      raw: "[5] A. Vilenkin and E. P. S. Shellard, Cosmic Strings and Other Topological Defects (Cambridge University Press, 2000).",
      title: "Cosmic Strings and Other Topological Defects",
      authors: ["A. Vilenkin", "E. P. S. Shellard"],
      year: "2000",
      venue: "Cambridge University Press",
    },
    {
      n: 12,
      raw: "[12] J. J. Blanco-Pillado, K. D. Olum, and B. Shlaer, The number of cosmic string loops, Phys. Rev. D 89, 023512 (2014), arXiv:1309.6637 [astro-ph.CO].",
      title: "The number of cosmic string loops",
      authors: ["J. J. Blanco-Pillado", "K. D. Olum", "B. Shlaer"],
      year: "2014",
      venue: "Phys. Rev. D 89, 023512",
      doi: "10.1103/PhysRevD.89.023512",
    },
    {
      n: 31,
      raw: "[31] C. J. A. P. Martins and E. P. S. Shellard, Extending the velocity dependent one scale string evolution model, Phys. Rev. D 65, 043514 (2002), arXiv:hep-ph/0003298.",
      title: "Extending the velocity dependent one scale string evolution model",
      authors: ["C. J. A. P. Martins", "E. P. S. Shellard"],
      year: "2002",
      venue: "Phys. Rev. D 65, 043514",
      doi: "10.1103/PhysRevD.65.043514",
    },
    {
      n: 40,
      raw: "[40] M. Bjornsson et al., The rise of self-driving labs in chemical and materials sciences, Nat. Synth. 2, 483 (2023).",
      title: "The rise of self-driving labs in chemical and materials sciences",
      authors: ["M. Bjornsson", "et al."],
      year: "2023",
      venue: "Nat. Synth. 2, 483",
      doi: "10.1038/s44160-022-00231-0",
    },
    {
      n: 42,
      raw: "[42] M. Bjornsson et al., The rise of self-driving labs in chemical and materials sciences, Nature Synthesis (2023).",
      title: "The rise of self-driving labs in chemical and materials sciences",
      authors: ["M. Bjornsson", "et al."],
      year: "2023",
      venue: "Nature Synthesis",
    },
  ];
  writeFileSync(`${BOOK}/references.json`, JSON.stringify(references, null, 2));
  console.log("夹具已安装（含样例 references.json，8 条目）");
} else if (mode === "restore") {
  if (!existsSync(BK)) throw new Error("无备份可恢复");
  copyFileSync(`${BK}/paper.md`, `${BOOK}/paper.md`);
  rmSync(`${BOOK}/images`, { recursive: true, force: true });
  cpSync(`${BK}/images`, `${BOOK}/images`, { recursive: true });
  rmSync(`${BOOK}/references.json`, { force: true });
  rmSync(BK, { recursive: true, force: true });
  console.log("已恢复原 paper.md/images，references.json 已移除");
} else {
  throw new Error(`未知模式 ${mode}`);
}
