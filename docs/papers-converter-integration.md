# Papers_Converter 整合进 SageRead · 实施交接文档

> 2026-08-04 建立。单篇 PDF 论文导入解析入库全流程（sidecar 模式，与 Books_Converter 整合同构，见 docs/books-converter-integration.md）。

## 一、架构

```
papers 页「导入 PDF」按钮
  → paper-service.ts startPaperPdfImport（converter-store 读引擎/Token + resolveLlmParams 读辅助模型）
  → Rust convert_paper_pdf（core/paper_converter.rs）
  → sidecar papers_converter --headless --output-dir {appData}/papers-converter [--provider E]
     · env：MINERU_TOKEN / PADDLEOCR_TOKEN / GLM_OCR_API_KEY / DEEPSEEK_*（元数据提取 LLM）
     · stdout 逐行 JSON 进度（start/progress/stage_done/done/error）
  → 事件 paper-convert://progress 逐行转发（+ Rust 补发 terminated）
  → done 后前端复用 importPapers(paper_dir, folderId)（scan_papers_dir → save_paper 既有链路）
```

取消：`cancel_paper_convert` kill 子进程；进度对话框关闭即取消。

## 二、JSON 进度协议（Papers_Converter --headless）

与 Books_Converter 同构（SageRead 两侧共用解析习惯）：

```
{"type":"start","title","engine"}
{"type":"progress","stage":1-4,"stage_name","detail","fraction","percent"}   # percent 单调不减
{"type":"stage_done","stage","stage_name","elapsed","percent"}
{"type":"done","slug","paper_dir","paper_md","title","elapsed","percent":100}
{"type":"error","message"}                                                    # 退出码非 0
```

阶段编号（前端阶段列表按此展示）：1=OCR 解析（stage_name=实际 provider）/ 2=元数据提取 / 3=内容处理 / 4=渲染装订。percent 区间：stage1 0-70%，后三段各 10%。

## 三、Papers_Converter 侧落地（2026-08-04）

- `progress_headless.py`：HeadlessProgress（阶段区间映射、percent int 单调、stdout 行 JSON flush）
- `pipeline.py`：`--headless` 参数（仅单篇路径）；provider progress 回调接入 stage 1；失败发 error 事件 + 非 0 退出
- `config.py`：frozen（PyInstaller）时锚定 `sys.executable` 目录（否则输出目录落 _MEIPASS 临时目录被删）
- `papers_converter_cli.spec` → `dist/papers_converter.exe`（56MB；hiddenimports 含四个 stage1 懒加载模块 + pypinyin 数据）

## 四、SageRead 侧落地（2026-08-04）

- sidecar：`binaries/papers_converter-x86_64-pc-windows-msvc.exe`（gitignore 不入库）+ tauri.conf externalBin + capabilities shell allow-spawn/kill
- Rust `core/paper_converter.rs`：`convert_paper_pdf` / `cancel_paper_convert` / `PaperConverterState`（事件转发同 Books 模式）
- 设置（converter-store，本机不入备份/同步）：`paperEngine`（paddleocr 基线 / mineru 表格备选 / glm 第二备选）+ `glmApiKey`；MinerU/PaddleOCR Token 与书籍转换共享
- 设置页「PDF 转换」：书籍引擎与论文引擎两个选择区（Token 按引擎条件显示）
- papers 页：「导入 PDF」主按钮 + 四阶段进度对话框（关闭即取消；成功复用 importPapers 入库，选中文件夹时自动挂载）
- 解析产物：`{appData}/papers-converter/{slug}/{paper.md,images/,source.pdf}`（staging 缓存在 sidecar 输出目录 `_staging/`）

## 五、验证

- headless 协议：真实 PDF（zotero-brain/parsed/2EL339RU）逐行 json.loads 校验通过，done 字段齐全
- exe 冒烟：同一 PDF 行为一致，产物锚定正确
- SageRead E2E（scripts/cdp-test-paper-pdf-import.mjs）：CDP + vite 模块注入走真实 startPaperPdfImport → 事件流 → done → 产物可扫描

## 六、遗留

- staging 的 LLM 元数据缓存（slug 防漂移，backlog 定论 converter 侧待实现）
- Zotero 批量导入（下轮；zotero_key 经 convert_pdf 参数透传锚定 slug）
- Books_Converter 同款 _MEIPASS 隐患（SageRead 侧恒传 --output-dir 规避，未修 converter 本体）
