# 安卓版移植计划（android-port-plan）

> 2026-09-06 首轮讨论定调并立项。路线：**Tauri 2 Android 目标**（同一 monorepo、同一 Rust 核心、同一 React 前端，新增编译目标 + 移动布局）。
> **状态：M2 已收官（2026-09-08 六项 spike 真机全绿，详见下文逐项结论）。下一步 M3 移动布局。**

## 已裁定事项（2026-09-06，用户拍板）

| # | 裁定 | 理由 |
|---|---|---|
| 1 | 走 Tauri 2 Android 目标，不开新仓库、不用 RN/Flutter/Capacitor | 140 个 Rust command、SQLite、L2 同步引擎、向量化插件全部在 Rust core，必须整体带走 |
| 2 | **EPUB 导入保留**（手机端可导入 EPUB） | 解析走 tauri-plugin-epub（纯 Rust，可交叉编译）；tauri-plugin-dialog 文件选择器支持 Android SAF |
| 3 | 分发先只做 GitHub Release 挂 APK（自签 keystore，零成本） | 不上架 Play（一次性 $25 + 审核流程留待以后）；安卓签名免费自签，与苹果 $99/年 无关 |
| 4 | 移动端定位 = 对话 + 阅读；解析/批量解析/Zotero 等重型任务不做 | 安卓不允许 spawn sidecar 子进程；"随手读"场景资源来自云端同步 |
| 5 | embedding 走远程 API（OpenAI 兼容）；手机端无本地 llamacpp | llamacpp 是 spawn 子进程，安卓不可行；远程 embedding 协议早已支持 |

## 环境现状（2026-09-06 实测）

已就绪：

- Android SDK：`%LOCALAPPDATA%\Android\Sdk` — platforms `android-37`、build-tools `36.0.0`、NDK `30.0.16138531`、cmdline-tools、emulator、adb 1.0.41
- Java：Android Studio 自带 JBR（OpenJDK 25.0.2）于 `F:\ProgramFiles\Android\Android Studio\jbr`
- tauri-cli 2.8.0；`Cargo.toml` 已有移动端预埋（`staticlib/cdylib` crate-type；global-shortcut/updater 已 `cfg(not(android/ios))` 门控）；`lib.rs:103` 已有 `#[cfg_attr(mobile, tauri::mobile_entry_point)]`

~~待补齐~~（2026-09-06 已补齐）：

- [x] 用户级环境变量：`ANDROID_HOME` / `NDK_HOME` / `JAVA_HOME` 已 setx 写入用户级（新开的终端/IDE 窗口生效）
- [x] Rust 交叉编译目标：四个安卓目标已全部 `rustup target add`

## 里程碑

### M0 · 工具链冒烟（目标：跑出第一个 debug APK）

- [x] 设环境变量（setx 用户级 + 当前会话 export）
- [x] `rustup target add` 四个安卓目标
- [x] `pnpm tauri android init`（2026-09-06 生成 `src-tauri/gen/android/`，工程名 better_sageread）
- [x] **Windows 开发者模式**（2026-09-06 开启）：tauri CLI 需 symlink `libsage_read_lib.so` → `gen/android/.../jniLibs/`，Windows 默认禁止无特权 symlink；注册表 `HKLM\...\AppModelUnlock\AllowDevelopmentWithoutDevLicense=1`（设置 → 系统 → 开发者选项 里的"开发人员模式"同效）
- [x] **Gradle 发行包预置**（2026-09-06）：wrapper 从 services.gradle.org 下载超时；保留仓库内官方 `distributionUrl` 不动，手动从腾讯镜像 `https://mirrors.cloud.tencent.com/gradle/gradle-8.14.3-bin.zip` 下载（13s vs 超时）放入 `%USERPROFILE%\.gradle\wrapper\dists\gradle-8.14.3-bin\cv11ve7ro1n3o1j4so8xd9n66\`，wrapper 自检zip存在即跳过下载直接解压
- [x] **JDK 25 → JDK 21**（2026-09-06，预案兑现）：Gradle 8.14.3 在 JBR 25 上报 `Unsupported class file major version 69`（class 69 = Java 25，Groovy 编译器不认）。免安装 Microsoft OpenJDK 21 解压至 `.tools/jdk-21.0.12.1+1`（.tools 已 gitignore），`JAVA_HOME` 用户级变量已改指此处；Android Studio 自身仍用它内嵌的 JBR，互不影响
- [x] Rust 交叉编译全绿（第六轮，24.74s 增量，`libsage_read_lib.so` 产出——M1 编译门禁被编译器实质验收）
- [x] **`tauri android build --debug --apk` 全链路首胜（2026-09-06 第九轮）**：产物 `gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`（369MB——debug 未 strip 属正常，release 配置已有 lto+strip，体积届时再评）。九轮踩坑：OpenSSL→rustls、capabilities 分流、tauri.android.conf.json 覆写 externalBin、窗口 API 门控 ×2、builder 消费结构、开发者模式 symlink、Gradle 镜像预置、JDK 25→21
- [x] 装机启动验收（2026-09-07 通过）：真机 Huawei Pura 70 Pro（HBN-AL00，HarmonyOS 4.2，AOSP 兼容）→ `adb install` 成功 → `MainActivity` 前台运行、书库页完整渲染（截图 `.tools/android-first-boot.png`）。桌面式排版在手机上溢出属预期，M3 处理
- [ ] 验收：APK 产出；手机插 USB 开调试后 `adb install` 能装上、能启动（布局稀烂无所谓）

已知坑预案：**JBR 是 JDK 25**，若 Gradle 版本过旧报 "unsupported class file version"，改 `winget install Microsoft.OpenJDK.21` 并把 `JAVA_HOME` 指过去。

### M1 · 编译门禁（目标：`tauri android build` 稳定通过）

把桌面专属模块全部 `cfg(not(mobile))` 门控（代码保留给桌面版，只做条件编译隔离）：

- [x] `lib.rs` 插件注册分流：updater / global-shortcut（2026-09-06 完成；顺手修掉一个隐患——`tauri-plugin-updater` 此前同时声明在 `[dependencies]` 和 target 段，门控形同虚设，已从 `[dependencies]` 移除）
- [x] **TLS 栈按平台分流**（2026-09-06，首轮构建失败后必修）：安卓不可交叉编译 OpenSSL，三个自有 manifest（主 crate / jan-utils reqwest 0.11 / epub 插件）全部改为桌面 native-tls、移动端 rustls+webpki 双段声明；改后 `cargo tree -i openssl-sys --target aarch64-linux-android` 已清空
- [x] **capabilities 按平台分流**（2026-09-06，第二轮构建失败后必修）：`default.json` 无 `platforms` 字段却含 global-shortcut 权限，移动端构建期权限校验失败；三条 `global-shortcut:allow-*` 移入 `desktop.json`（该文件本就限定 macOS/windows/linux）
- [x] **sidecar 二进制的安卓覆写**（2026-09-06，第三轮构建失败后必修）：tauri-build 为 externalBin 找 `*-aarch64-linux-android` 后缀二进制直接报错。解法是 Tauri 平台配置文件约定——新建 `src-tauri/tauri.android.conf.json`（`bundle.externalBin: []`），CLI 构建安卓时自动按文件名合并，无需 --config 参数；桌面构建不受影响
- [x] **移动端缺失的窗口 API 门控**（2026-09-06，第四轮构建失败后必修，仅 2 处）：`set_decorations`（原运行时 `consts::OS` 判断改为编译期 `cfg(windows)`，桌面行为不变）；`window.destroy` 与整个 `on_window_event` CloseRequested 处理器门控为桌面专属（移动端无此 API、事件亦不触发）
> M1 定性更新（2026-09-06，第六轮构建后）：**编译期门禁已全绿**——下列模块（converter/mcp/llama/local_api/zotero）在安卓上其实都能编译（std/tokio process API 编译没问题，只是运行时会失败），所以它们不再是编译问题，而是"运行期不可用 + 前端入口需隐藏"问题，随 M4 功能面打磨一并处理；此处保留仅为追踪。

- [ ] `core/converter.rs` / `core/paper_converter.rs`（sidecar spawn；运行期禁用 + 前端转换器页隐藏）
- [ ] `core/mcp/`（stdio 子进程桥）+ `McpStdioState`
- [ ] `core/llama/` + tauri-plugin-llamacpp（spawn 向量服务）
- [ ] `core/local_api/`（localhost 迷你 HTTP，手机端无消费方）
- [ ] `core/zotero.rs`（本地库扫描）
- [ ] Windows 窗口装饰 / 托盘 / global shortcut 相关 setup 分支
- [ ] 前端对应入口在安卓端隐藏（转换器页、Zotero 导入、本地向量模型选项、批量向量化入口）
- [ ] 验收：debug APK 构建绿；桌面版 `pnpm tauri build` 回归不炸（门控不能影响桌面）

### M2 · 核心链路 spike（目标：六项风险全部实测出结论，再投大改）

按优先级逐项在真机/模拟器实测，结论记录回本文件：

**M2 总结论（2026-09-08，Huawei Pura 70 Pro 真机实测，六项全过）**。测试基建：debug 构建内置 `core/mobile_spike.rs`（仅 `debug_assertions + android` 编译，启动自检打印 `[M2SPIKE]` 到 logcat）；PC 侧 dufs WebDAV + node mock LLM，经 `adb reverse` 供手机回环访问；WebView 用 CDP（`adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`）驱动，驱动脚本 `.tmp-e2e/m2-cdp.mjs` / `m2-cdp-listen.mjs`。

1. [x] **sqlite-vec 交叉编译到安卓** — PASS。编译期随 M0/M1 构建绿证明；运行期真机实测 vec0 建表/向量写入/KNN 查询全通（KNN 结果数值正确）。RAG 命根子保住。
2. [x] **keyring 安卓后端** — PASS，但方案与预研不同：keyring 4.2.0 的 `v1` 门面**不支持安卓**（自动选型仅 macOS/Windows/非安卓 *nix，`Entry::new` 恒报 NoDefaultStore）。落地做法 = 安卓端直连 `keyring-core` + `android-native-keyring-store` 1.0，启动时 `set_default_store(Store::new())`（ndk-context 由 Tauri 初始化，无需自带 Kotlin 胶水）；桌面三端继续走 v1 门面（feature 改名：`windows-native-keyring-store` / `apple-native-keyring-store` / `dbus-secret-service-keyring-store`）。真机实测：写→读→删回环 OK；**跨 force-stop+重装持久化成立**（Keystore 硬件级，重启手机按设计亦保持，未专门测）。另：升级要求 rustc ≥1.88（已升到 1.98.1）。
3. [x] **WebDAV 同步** — PASS。真机走通：test_connection（MKCOL）→ 配置落盘 → L1 全量备份上传（zip+资产包，云端实见）→ L2 run_sync 推送 1107 行 changeset（云端实见设备注册与包）。pull 为空载执行（云端无待拉取），非空 pull 语义由桌面 sync-e2e 套件覆盖。鸿蒙注意：应用退后台立刻被 WorkingsetPause 冻结（首轮 spike 因此假死），实测时须保前台+常亮。
4. [x] **EPUB 解析 + foliate-js 渲染** — PASS。Android WebView 实测：DocumentLoader 解析 OK、分页 OK（1.6MB 书 713 页）、目录链接跳转 OK（点 TOC 跳到第 44 页）、图文混排正常。asset 协议（`http://asset.localhost/<encodeURIComponent(绝对路径)>`）取书 200 正常。遗留噪音：字体 URL 双重编码（`http://asset.localhost/asset%3A%2F%2F...`）刷 500 ×17——字体加载链路在安卓有独立 bug，M3/M4 修；书中远程图片（notion.so）会真发外网请求，CSP connect-src 已含 http: 放行。
5. [x] **AI 流式对话** — PASS。mock OpenAI 兼容 SSE 服务（80ms/片逐字）经 adb reverse 供机；openai-compatible 走 Tauri fetch（Rust reqwest），WebView 逐 token 收完整段回复。AI SDK + 流式通道在 Android WebView 稳定。
6. [x] **EPUB 导入链路** — PASS（修了一个真 bug）。`<input type=file>` 在 Tauri 安卓 WebView 正常唤出 SAF 选择器（**需真实手势**：CDP `el.click()` 不弹，`Input.dispatchMouseEvent` 才弹）；选中后 File API 读字节 → fs 插件写临时文件 → `save_book` 入库全通。**坑：安卓无 TMPDIR，`std::env::temp_dir()` 落 `/data/local/tmp`（应用无写权限，导入报 Permission denied）——已修：lib.rs setup 安卓分支把 TMPDIR 指到 app cache 目录。**

M2 顺带的测试基建沉淀（复跑照单）：spike 模块 `packages/app/src-tauri/src/core/mobile_spike.rs`；mock LLM `.tmp-e2e/mock-llm.mjs`；CDP 驱动 `.tmp-e2e/m2-cdp.mjs`（eval/tapjs 两命令）；dufs `.tools/dufs.exe -A --bind 127.0.0.1 --port 4918 .tmp-webdav-root` + `adb reverse tcp:4918 tcp:4918`（mock 用 4920）。

### M3 · 移动布局（工作量最大一站；纯前端，不动数据层）

**已裁定事项（2026-09-08 设计讨论，用户拍板）：**

| # | 裁定 | 要点 |
|---|---|---|
| 1 | **标签页栏砍掉（仅 UI）** | 手机同时只活一本书，开新书旧书即回收；**无标签页关闭语义**——书一旦打开就永远以"休眠标签页"形式存在，但休眠 = 只有 SQLite 行 + 最近阅读记录，不保留 DOM/活实例，资源占用必须为真零（防滚雪球）。桌面多开基建不动 |
| 2 | **手势地图** | 单击阅读区中央 = 弹出/收回上下栏；左右边缘 = 翻页（竖向三栏：左翻/菜单/右翻），滑动翻页保留；**长按句子 = 选中整句** + 操作条（问 AI/复制/标注，对齐桌面——翻译不在操作条，翻译是独立语义）；选中态带拖柄可改任意范围（长按给句子、拖柄给自由） |
| 3 | **AI = 底部抽屉** | vaul（已在依赖）；半屏/全屏两档 snap；**返回键任何档位都直接收起**（无"先收半屏"）；点阅读区空白/下拉也收起；**收起绝不清未发送草稿，重拉原样复原**。入口两个：下栏中央 AI 按钮 + 长按句子"问 AI"（带引用自动拉起）。内容复用 SideChat 组件，只换容器 |
| 4 | **首页 = 继续页** | 左上 Better SageRead icon+字样；「继续阅读」书籍大卡横向轮播（可左右拖），论文用列表；均按 last_read_at 截断（查询截断，无滚雪球）；无历史整块自动隐藏；**无"继续对话"**（对话与书耦合，打开书即打开对话）；下方主选项列表：图书馆/论文库/全局助手/阅读统计，点进去才铺内容 |
| 5 | **PDF 手机端不支持** | 书籍只认 EPUB，论文只认转换后 Markdown；PDF 转换基地 = 电脑端，经同步过来；手机端不打包两个转换器 |
| 6 | **全局助手 = 独立页**（非抽屉） | 它不附着于书。**Agent 手机端权限收敛**：禁完全访问；只对着库内书籍/论文问答 + 必要时网络搜索；工作目录落 app 私有目录。主题修改等 UI 操作的工具映射待细化（见 M4） |
| 7 | **断点：竖屏先行** | 竖屏单栏做透再谈折叠屏/平板横屏（暂无测试设备） |

阅读页栏位：上栏 = 左返回 + 右上溢出菜单（翻译/字体/背景/设置）；下栏 = 目录 | 划线笔记 | **AI（中央主按钮）** | 进度。刘海/挖孔 safe-area-inset；阅读页返回 = 回书库而非退出。

实施批次（建议顺序）：

- [ ] M3-a 基建：`isMobile` 平台判定 hook + 竖屏单栏壳 + safe-area 变量
- [ ] M3-b 首页改版（继续阅读轮播 + 论文列表 + 主选项；空态退化）
- [ ] M3-c 阅读页上下栏 + 手势重映射（单击弹栏 / 长按切句带拖柄 / 边缘翻页）
- [ ] M3-d AI 底部抽屉（vaul 容器复用 SideChat；草稿持久；长按问 AI 带引用拉起）
- [ ] M3-e 标签栏隐藏 + 单书回收策略（离开阅读页即卸载，只留 DB 状态）
- [ ] M3-f PDF 收口：导入 accept 只给 .epub；库内已有 PDF 灰显"请在电脑端转换后阅读"
- [ ] M3-g 全局助手独立页 + Agent 权限收敛（禁完全访问开关）
- [ ] 横竖屏旋转：响应 resize，阅读进度不丢（foliate-resize-update 已有事件）
- [ ] 验收：手机竖屏全流程可读可聊；长按问 AI 丝滑链路（选中→抽屉→上下文引用）走通

M3 已知欠账（M2 实测发现）：字体 URL 双重编码导致安卓字体 500（`asset.localhost/asset%3A%2F%2F...`，convertFileSrc 被二次调用），修字体链路时一并处理。

**M3.5 可用性打磨（2026-09-08 用户真机试用后立项，插队在 M4 功能面之前）：**

框架（M3）搭完但毛坯——体验问题不进 M4 以后，单列本批次立刻打磨。方法：结构件先行（导航返回栈）→ 逐页 CDP 巡检截图建缺陷清单 → 分批修 → 视觉对标微信读书（用户供截图参考）。

用户首轮实测反馈（原话归档）：进入了某页面回不来（无返回按钮/手势）；文字或选项跑出屏幕外；对话记录看不到；管理对话的多选窗口出现在奇怪位置且无法收起；部分文字诡异竖排；工具按钮位置不合理。

- [x] M3.5-1 导航返回栈：MainActivity.onKeyDown 全量转前端 `window.__androidBack`（不走 webview.goBack——阅读器开合是 layout-store 状态非路由历史）；消费顺序 = 抽屉/弹层 → 设置对话框 → 阅读页回主页区 → 二级页回首页 → 首页退出（invoke mobile_exit_app）。论文阅读器外包返回栏。**真机实测四段全通**（抽屉→收、阅读→主页、二级页→首页、首页→退出）。
- [ ] M3.5-2 逐页巡检缺陷清单（2026-09-08 首轮 CDP 截图巡检 `.tmp-e2e/m3-sweep/`，含用户实测反馈）：
  - [ ] **竖排大标题**（图书馆"我的图书"/论文库"文献库"/阅读统计/回收站同病）：页内桌面大标题被挤成一字宽逐字竖排。统一修法：移动端隐藏页内大标题块（壳已有返回栏标题）
  - [ ] **论文库双栏挤爆**：文件夹侧栏占半屏、论文卡片溢出右缘 → 文件夹收成顶部抽屉/下拉，卡片单列
  - [ ] **设置对话框右缘溢出**（"全局主题"选择器等控件被裁）：移动端全屏化 + 单列堆叠
  - [ ] **论文阅读页三栏塌陷**：只剩聊天栏可见，论文本体零宽 → 需移动端重排（正文 + 聊天抽屉化）
  - [ ] 聊天多选/管理弹窗位置异常且无法收起（用户实测）
  - [ ] 部分工具按钮位置不合理（用户待细讲）
- [ ] M3.5-3 视觉对标打磨（参考微信读书/ScholarRead；主题系统移动端兼容一并在此）

**M3 进展日志（2026-09-08）：**

- M3-a/b 已装车实测通过：`utils/mobile.ts` 平台判定（UA 同源）；`MobileLayout` 顶层换壳（桌面 JSX 零改动，hooks 全保留）；首页 = 继续页（继续阅读轮播 ≤3 书 + 最近论文 ≤3 + 主选项 + 回收站/设置 + 下拉同步刷新），真机渲染良好；图书馆二级页带返回壳可用；云端书按需下载走通（点到即下，文件齐）；safe-area env 变量接通。
- M3-c/d 已装车实测通过（第十一轮 APK）：单击中央弹/收上下栏；左右边缘翻页；**长按切句 → 复制/Ask AI/标注弹窗**（合成 contextmenu 复用桌面右键路径）；Ask AI 抽屉未开时自动拉起 + 事件延迟 400ms 重放，引用入输入区实测成功；目录抽屉跳转（前言 → P25）；笔记抽屉（NotepadContainer 复用）；AI 抽屉两档（半屏 55dvh / 把手上推全屏）、遮罩点按收起正常、**草稿 store 化（chat-draft-store，按 scope:bookId 分键）收起重拉原样**。
- M3-e 已落地：标签栏不渲染；单书存活（layout-store 新增 ensureReaderStore/disposeReaderStoresExcept，启动不为历史 tab 重建 store）。
- M3-f 已落地：导入仅 .epub；库内 PDF 灰显 + 点击提示"请在电脑端转换"（测试机库里无 PDF，仅代码路径验证）。
- M3-g 已落地：全局助手独立页（/chat，常驻保活护流式，带返回栏实测可用）；Agent 移动端固定严格模式（agent-settings-store 水合 merge + setSafetyMode 双侧拦截 full/relaxed；设置页只读展示）。
- 踩坑记录（vaul 1.1.2）：① snapPoints 与固定高度互斥（Content 会被二次平移只露一条缝）——TOC/笔记用固定 55dvh 无 snap；② forceMount 保活会让关闭态抽屉僵尸化（data-state=closed 但不下屏）——弃用，草稿改 store 化；③ snap 点位语义是"内容顶部露出比例"，聊天下置输入框在分数点位下不可见——AI 抽屉改自管两档高度（onDrag 负位移上推全屏）。
- 实测注意：**大书首开分页期间 JS 主线程长阻塞会触发系统 ANR 弹窗**（《三十年河东》首开约 1 分钟不可交互，之后正常）——大书分页性能是 M4 观察项（folio 全量 layout 在手机上偏贵；恢复后阅读流畅）。
- 实测注意：L2 调度器在手机上按 25s tick 正常工作（前台），阅读会话持续写库会持续推 changeset——流量策略符合"改完即 push"裁定，电池影响 M4 再评。
- 移动端欠账（M4+）：硬件返回键语义未接（vaul 只管 Escape；安卓返回手势目前不回退抽屉/阅读页）；横竖屏旋转；平板/折叠屏断点；主题美学细节打磨（深色模式已随全局主题正常）。

### M4 · 功能面打磨

- [ ] 全文翻译（纯前端 transformer + AI API，零改动预期，实测验收）
- [ ] 单书/单篇向量化 + RAG 对话（远程 embedding；UI 隐藏本地模型选项）
- [ ] 设置页精简：隐藏桌面专属分栏（proxy 全局快捷键/updater/MCP/llama 等）
- [ ] 更新通道：检测 GitHub 新版 → 弹窗 → 跳浏览器 Release 页（不做应用内更新）
- [ ] 同步策略落实："打开 App 时 pull + 更改后即时 push"（安卓无可靠后台，不做定时同步）

### M5 · 发布

- [ ] 生成签名 keystore（`keytool -genkey`，备份进密码管理器；**丢了无法覆盖更新**）
- [ ] `tauri android build --apk --release` 签名产物
- [ ] GitHub Actions：安卓构建 job（ubuntu runner + SDK/NDK + Rust targets）
- [ ] Release 约定：**同一 tag 同一 Release** 挂 `windows.msi` + `android.apk` 多资产，版本号共享 `tauri.conf.json` version

## 附 A：华为真机 USB 调试施工记录（2026-09-07，换机/重装时照单复现）

鸿蒙 4.2（AOSP 兼容）连 Windows 11 25H2 的完整坑链与解法：

1. **华为 HiSuite 驱动 vs 内存完整性（HVCI）**：HiSuite 的 `ew_usbccgpfilter.sys` 过滤驱动被 HVCI 拦截 → 挂在手机 USB 复合设备上 → Code 39，MTP/ADB 全灭。华为官方支持文档承认此问题且方案就是关内存完整性（consumer.huawei.com/cn/support/content/zh-cn15876665）。**我们的选择：不动 HVCI，弃用华为驱动**。
2. **清理**：卸 HiSuite → `pnputil /remove-device` 删设备实例 → `pnputil /delete-driver oem275.inf /uninstall` 删驱动包（残留 `UpperFilters=ew_usbccgpfilter` 在 Enum 键里，SYSTEM 专属 ACL，reg delete 也会被拒，只能靠卸驱动包让 SetupAPI 清理）。脚本：`.tools/fix-hdb.ps1` / `fix-hdb2.ps1`。
3. **Google 驱动绑定的三重过滤**：① MI_02 ADB 接口被系统 inbox winusb.inf 以 `USB\MS_COMP_WINUSB` 抢占，adb 只认 AndroidUsbDeviceClass；②"从列表选"按设备类别过滤，看不到 Google（不同类）；③"从磁盘安装"按硬件 ID 过滤，原版 inf 全是 Google 自家 VID → 25H2 直接报"没有兼容驱动"。
4. **自签方案（最终采用）**：复制 Google inf 并追加一行 `%CompositeAdbInterface% = USB_Install, USB\VID_12D1&PID_107E&MI_02`（文件在 `.tools/huawei-adb/`）→ SDK 自带 `makecat.exe` 生成 `.cat`（WDK 才用的 Inf2Cat 不需要）→ `New-SelfSignedCertificate` 自签证书（CN=SageRead Dev Driver Signing，指纹 **AD674E3E1526E96110822D4C110DD8E360D77DD3**，已导入 LocalMachine Root + TrustedPublisher；移除方法：certmgr.msc 删该证书）→ `signtool sign` 签 `.cat` → `pnputil /add-driver ... /install` 一把成功（oem279.inf），驱动包永久入库，换端口/重插自动绑定。脚本：`.tools/fix-hdb5.ps1`。
5. **手机侧三件套**：开发人员选项 → USB 调试 + **"USB调试（安全设置）"**（不开它 `adb install` 报 `User rejected permissions`）→ 首次连接手机弹 RSA 授权框点"始终允许"。
6. **Git Bash 使用 adb 的注意**：`adb shell`/`pull` 的路径参数会被 MSYS 路径转换吃掉，需 `export MSYS_NO_PATHCONV=1`。
7. 其他：`HDB Interface`（MI_03）叹号无害（HiSuite 私有协议口，不用）；无线调试鸿蒙 4.2 未找到入口。

## 风险登记册

| 风险 | 等级 | 应对 |
|---|---|---|
| ~~JDK 25 与 Tauri 模板 Gradle 版本不兼容~~ | 已兑现 | M0 已解决（JDK 21 免安装到 .tools） |
| ~~sqlite-vec 交叉编译失败~~ | 已消解 | M2-1 实测通过 |
| ~~keyring android-native 实测不稳定~~ | 已消解 | M2-2 实测通过（v1 门面不支持安卓，直连 keyring-core 落地） |
| ~~foliate-js 在 Android WebView 性能/兼容~~ | 已消解 | M2-4 实测通过；大书性能留 M3 观察 |
| 安卓后台冻结导致同步"不自动" | 已定策略 | 打开即 pull、改完即 push；阅读场景可接受。M2-3 实测印证鸿蒙后台秒级冻结（WorkingsetPause），策略成立 |
| 手机内存压力下大书/向量检索 OOM | 低 | 休眠机制直接受益；M3 实测 |
| 字体加载 URL 双重编码（`asset.localhost/asset%3A%2F%2F...` 500） | 中（新，M2-4 发现） | 字体链路在安卓必坏；M3/M4 修（convertFileSrc 被二次调用） |
| 桌面布局手机上零宽度/溢出（聊天栏挤压书页到 0 宽、按钮溢出视口） | 已定（M3 主战场） | M2 实测全程目击；M3 断点与导航形态解决 |

## 仓库与发布约定

- 同一 monorepo；`src-tauri/gen/android/` 随仓库提交（Tauri 官方建议，签名等定制都在里面）
- 桌面/移动共享 `tauri.conf.json` version；Release 同 tag 多资产
- 桌面专属代码一律 `cfg` 门控隔离，**不得**为移动端删桌面功能
