# Release Notes（下次发版用）

**发版前把本文件改为本次发布的更新说明**（中文、Markdown、面向用户）。
CI（`.github/workflows/release.yml`）会把本文件内容同时用作：

- GitHub Release 正文；
- 更新清单 `latest.json` 的 `notes` 字段——应用内「检查更新」确认框直接展示。

## 写法约定

- 第一行 `# Better SageRead vX.Y.Z — 一句话主题`；
- 按「修复 / 功能与体验 / 其他」分节，写给用户看，不写 commit 哈希；
- 口径参考 v0.2.1 的 Release 正文（含末尾致谢段）。

## 发版动作（供执行者核对）

1. 改写本文件 → 提交；
2. 打 tag（`v*`，如 `git tag -a v0.2.2 -m "..."`）并 push tag；
3. CI 自动构建并产出 **draft** Release（版本号/identifier 由 CI 从 tag 同步）；
4. 检查 draft 内容与资产无误后发布；发布后 `cos-sync.yml` 自动把安装包
   同步到国内 COS（无需手动传包）。
