# 发布工作流程

本文档说明如何发布 Better SageRead 的新版本。

> **2026-08-14 重写**：项目已从 xincmm/sageread 独立演进为 Better SageRead（仓库 `github.com/Feplus2/better-sageread`），发布链路与上游不同处集中见文末「本分支特有事项」。

## 前置要求

1. ✅ GitHub Actions 配置完成（`.github/workflows/release.yml`）
2. ⚠️ GitHub Secrets 已设置 **`TAURI_SIGNING_PRIVATE_KEY`**（必填，内容为本地 `~/.tauri/better-sageread.key` 文件全文）与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（可选，生成时未设密码则留空/不设）——**不配则自动更新永远不可用**（updater 验签失败）
3. ✅ 有仓库的 push 权限
4. ⚠️ 仓库需为 **public**（否则 Release 资产与 updater 的 `latest.json` 外界无法下载）

---

## 完整发布流程

### 第一步：准备发布

```bash
cd /f/MyProjects/SageRead

# 1. 修改版本号
# 编辑 packages/app/src-tauri/tauri.conf.json
# 将 "version": "0.1.1" 改为新版本号（CI 最终会用 tag 名覆盖，但保持 conf 同步是好习惯）

# 2. 查看自上次发布以来的改动（可选）
git log --oneline v0.1.1..HEAD

# 3. 提交版本变更
git add .
git commit -m "chore: bump version to x.x.x"

# 4. 推送 main 并创建推送 tag（本地工作分支名为 local）
git push origin local:main
git tag -a vX.X.X -m "Release vX.X.X"
git push origin vX.X.X
```

---

### 第二步：GitHub Actions 自动构建

推送 tag 后，GitHub Actions 会：
- ✅ 构建 macOS (Intel + Apple Silicon)
- ✅ 构建 Windows
- ✅ 生成安装包
- ✅ 生成 `latest.json`（用于自动更新）
- ✅ 创建 Draft Release（草稿状态）

⏱️ 大约需要 15-30 分钟

**查看构建进度**：
```
https://github.com/Feplus2/better-sageread/actions
```

---

### 第三步：编写并发布 Release Notes

#### 3.1 进入 Releases 页面

```
https://github.com/Feplus2/better-sageread/releases
```

#### 3.2 编辑 Draft Release

点击 Draft Release 的 "Edit" 按钮

#### 3.3 编写 Release Notes（Markdown 格式）

**基础模板**：
```markdown
## ✨ 新功能

- 功能1描述
- 功能2描述

## 🐛 Bug 修复

- 修复的问题1
- 修复的问题2

## 🔧 优化

- 优化项1
- 优化项2

## 📦 下载说明

选择适合你系统的版本：

- **macOS Apple Silicon (M 系列)**: `Better.SageRead_x.x.x_aarch64.dmg`
- **macOS Intel**: `Better.SageRead_x.x.x_x64.dmg`
- **Windows**: `Better.SageRead_x.x.x_x64-setup.exe`

> ⚠️ **macOS 未签名**：本版本未用 Apple 开发者证书签名，首次打开会被 Gatekeeper 拦截。
> 安装后在终端执行一次：`xattr -dr com.apple.quarantine "/Applications/Better SageRead.app"`
>
> ⚠️ **macOS 版暂不含 PDF 转换功能**（转换器 sidecar 暂无 macOS 构建），书籍/论文转换按钮会报错；
> 其余功能完整。Windows 版功能完整。

**首次安装用户**：直接下载安装即可  
**已安装用户**：应用会自动检测并提示更新
```

#### 3.4 检查附件

确认以下文件已上传：
- ✅ macOS Apple Silicon 安装包 (`.dmg`)
- ✅ macOS Intel 安装包 (`.dmg`)
- ✅ Windows 安装包（`.exe`，NSIS + `.msi`）
- ✅ `latest.json` 文件（关键！）
- ✅ 各安装包对应的 `.sig` 签名文件（updater 验签用）

#### 3.5 发布

点击 **"Publish release"** 按钮

---

### 第四步：验证自动更新（可选）

1. 在本地安装旧版本
2. 启动应用
3. 应该会检测到新版本
4. 自动下载并提示安装

---

## Release Notes 技巧

### Markdown 功能

- **引用 Issue/PR**：使用 `#123` 自动转为链接
- **表情符号**：直接使用 emoji 或 `:emoji:` 格式
- **代码块**：使用三个反引号
- **图片**：`![alt](url)`
- **粗体**：`**文字**`
- **列表**：`-` 或 `1.`

### 示例

```markdown
## 🎉 重大更新

本次版本带来了全新的字体系统！

### 新功能
- ✨ 内置寒蝉活宋体 [#123](issue链接)
- 🚀 支持向量模型平台自动识别

### 改进
- 📦 移除网络字体依赖，减小包体积 50%
- ⚡ 启动速度提升 30%

### 截图

![新界面](screenshot-url)

### 注意事项

> ⚠️ 本版本需要重新配置字体设置
```

---

## 常见问题

### Q: 构建失败怎么办？

1. 查看 GitHub Actions 日志
2. 检查版本号格式是否正确
3. 确认所有依赖都已提交

### Q: 用户不能自动更新？

检查：
- ✅ `latest.json` 是否存在
- ✅ 版本号是否大于当前版本
- ✅ Release 是否已发布（不是 Draft）

### Q: 如何删除错误的 Release？

1. 进入 Releases 页面
2. 点击对应 Release
3. 点击 "Delete" 按钮
4. 删除对应的 Git tag：
   ```bash
   git tag -d v0.1.1
   git push origin :refs/tags/v0.1.1
   ```

---

## 本分支特有事项（2026-08-14 起）

- **identifier 双形态**：仓库内 `tauri.conf.json` 是开发形态 `com.bettersageread.dev`；CI 的 "Sync version" 步骤会改写为发布形态 `com.bettersageread.app`。两个 identifier 的应用数据目录互相隔离（`%APPDATA%\com.bettersageread.dev\` vs `...\.app\`），本机 dev 实例与安装版互不影响。
- **转换器 sidecar 已入库**：`books_converter`/`papers_converter`（各约 55-60MB，Windows x64）直接随 git 分发，Windows 构建开箱即有转换功能。**macOS 暂无转换器构建**：CI 在 mac 构建前会动态摘除这两条 externalBin（release.yml "Strip converter sidecars" 步骤），mac 版转换按钮会报错——属预期，待转换器仓（Papers_Converter / Books_Converter）开源并建 macOS release 后恢复。
- **updater 密钥自有**：`tauri.conf.json` 的 pubkey 对应私钥在 `~/.tauri/better-sageread.key`（2026-08-14 生成，无密码）。**私钥文件丢了就永远失去自动更新能力**，请离线备份；同时把文件全文配进 GitHub Secrets 的 `TAURI_SIGNING_PRIVATE_KEY`。
- **fixture 版权清理**：论文测试 fixture 已换成 CC-BY 开放获取论文（`fixtures/papers/akter2026atscale`，附署名 README）；旧 zhao2020rational（订阅期刊全文）已于 2026-08-14 用 git filter-repo 从全部历史中清除。**因此首次推送需要 `git push --force-with-lease origin local:main`**（历史已重写，与远端 main 不再连续）。
- **macOS 未签名**：无 Apple 开发者证书，Release Notes 务必带 `xattr -dr com.apple.quarantine` 指引（模板已含）。

---

## 版本号规范

遵循 [语义化版本](https://semver.org/lang/zh-CN/)：

- **Major (x.0.0)**: 不兼容的 API 变更
- **Minor (0.x.0)**: 新功能，向后兼容
- **Patch (0.0.x)**: Bug 修复，向后兼容

**示例**：
- `0.1.0` → `0.1.1`: Bug 修复
- `0.1.0` → `0.2.0`: 新功能
- `0.9.0` → `1.0.0`: 重大变更

---

## 快速检查清单

发布前检查：

- [ ] 版本号已更新
- [ ] 所有改动已提交
- [ ] tag 已创建并推送
- [ ] GitHub Actions 构建成功
- [ ] Release Notes 已编写
- [ ] 所有安装包都已上传
- [ ] `latest.json` 存在
- [ ] Release 已发布（不是 Draft）

---

## 相关文件

- `.github/workflows/release.yml`: GitHub Actions 配置
- `packages/app/src-tauri/tauri.conf.json`: 版本号配置
- `packages/app/src-tauri/src/lib.rs`: 自动更新逻辑

---

更新日期：2026-08-14
