# sageread_markitdown sidecar

一次性 文件 → Markdown（LLM 友好）的 PyInstaller 单文件包，随安装包分发
（`packages/app/src-tauri/binaries/`，externalBin 登记，与 books_converter 同约定）。

## 协议（stdout 逐行 JSON，进程恒 0 退出）

```
sageread_markitdown <input_file> --output <out.md>
→ {"type":"progress","stage":"detect|convert","message":"..."}
→ {"type":"done","ok":true,"output":"...","chars":N,"engine":"markitdown","warnings":[]}
→ {"type":"done","ok":false,"error":"...","trace":"..."}
```

- `warnings` 含 `empty-output` = 提取为空（扫描件/图片型文档特征）——app 侧据此走
  MinerU/PaddleOCR 引擎兜底（Phase C）。
- stderr 噪声（pydub ffmpeg 警告等）不影响协议，Rust 侧只解析 stdout。

## 重打（Windows）

```bash
cd sidecars/markitdown
python -m venv .venv
.venv/Scripts/python.exe -m pip install markitdown magika mammoth lxml olefile openpyxl \
  python-pptx "pdfminer-six>=20251230" pdfplumber xlrd pandas pyinstaller
.venv/Scripts/python.exe -m PyInstaller sageread_markitdown.spec --noconfirm --clean
cp dist/sageread_markitdown.exe ../../packages/app/src-tauri/binaries/sageread_markitdown-x86_64-pc-windows-msvc.exe
```

注意：
- **不要往 spec 的 excludes 里加 pydub/speech_recognition 等"看似用不上"的包**——
  markitdown 在 import 时就加载各可选转换器（实测 venv 里 import 即触发 pydub
  警告），排了会让 exe 起不来。excludes 只留确定无 import 牵连的巨型 ML 包。
- spec 的 `collect_all("markitdown"/"magika")` 是必须的：magika 的 ONNX 模型文件
  靠它收进包。
- 依赖版本见 `pip install` 行（与 `.venv` 一致）；升级 markitdown 后重跑冒烟：
  `.venv/Scripts/python.exe main.py <某个 docx> --output out.md`。
