# 网站部署指南（腾讯云 · 手把手版）

这个网站由三部分组成，全部走腾讯云免费/低价套餐，支持微信/支付宝付款，
国内用户可直接访问，**全程不需要备案**（用平台默认域名）：

```
访客浏览器
   ├── 网页本体  ←  EdgeOne Pages（免费静态托管，默认域名 *.edgeone.app）
   ├── 安装包    ←  腾讯云 COS 对象存储（"高速下载"按钮，按流量计费，每月几块钱量级）
   └── 备用直连  ←  GitHub Releases（"GitHub"按钮，海外用户与镜像兜底）
```

网页会**自动**从 GitHub 拉取最新版本号、文件大小和下载次数——每次发新版，
你只需要「GitHub 发 Release + COS 传新包」两个动作，网页一个字都不用改。

预计一次性耗时：40–60 分钟。

---

## 0. 准备：注册腾讯云并实名认证

1. 打开 https://cloud.tencent.com ，微信扫码注册。
2. 进入「账号中心 → 实名认证」，完成个人认证（身份证 + 人脸，几分钟）。
3. 后续所有服务用这一个账号即可。

## 1. 把代码推上 GitHub（如果 site/ 还没推）

网站放在本仓库的 `site/` 目录。EdgeOne Pages 可以直接从 GitHub 仓库部署：

```bash
git add site/
git commit -m "feat(site): 工具箱下载站"
git push
```

仓库公开私有都可以（私有仓库在 EdgeOne 授权 GitHub App 时勾选授权即可）。

## 2. 上传安装包到 COS（"高速下载"通道）

1. 控制台搜索「对象存储」→ https://console.cloud.tencent.com/cos
2. **创建存储桶**：
   - 名称随意（如 `sageread-dl`），地域选离你近的（如广州 ap-guangzhou）
   - 访问权限：**公有读私有写**
   - 多 AZ、版本控制、加密都可以不开
3. 进入存储桶 → 「文件列表」→ **上传文件**，把当前所有安装包拖进去
   （`Better.SageRead_0.2.0_x64-setup.exe`、`Books_Converter-v1.3-win64.zip` 等，
   **文件名保持和 GitHub Release 完全一致**，网页靠文件名自动匹配）。
4. 点任一文件 → 「详情」→ 复制「默认域名」的链接，形如：
   `https://sageread-dl-1250000000.cos.ap-guangzhou.myqcloud.com/Better.SageRead_0.2.0_x64-setup.exe`
5. 打开 `site/assets/js/config.js`，把域名部分填进 `cosBase`：
   ```js
   cosBase: "https://sageread-dl-1250000000.cos.ap-guangzhou.myqcloud.com",
   ```
   填好后网页上的「高速下载」按钮自动出现并指向 COS；留空时只有 GitHub 按钮。

**费用量级**（以控制台实际价格为准）：存储约 0.1 元/GB/月（你的包总共不到 0.5GB）；
外网下行流量约 0.5 元/GB——135MB 的安装包被下载 100 次约 13.5GB ≈ 7 元。
个人工具站一个月通常几块钱以内。

**防盗刷**：存储桶 → 「概览」可以设置用量告警（如每月流量超 20GB 发短信）。
桶里只放安装包、不放别的，风险就很小。

## 3. 部署网页到 EdgeOne Pages

1. 打开 https://console.cloud.tencent.com/edgeone/pages
2. **创建项目 → 导入 Git 仓库**，按提示用 GitHub 账号授权，选中 `Feplus2/better-sageread`。
3. 构建配置：
   - **根目录**：`site`
   - 构建命令：留空（纯静态，无需构建）
   - 输出目录：`/`（即根目录本身）
4. 点部署，几十秒后得到默认域名，如 `https://xxx.edgeone.app`——
   这就是你的网站地址，**国内可直接访问，无需备案**。
   之后每次 `git push`，网站自动重新部署。

> 备选：不想连 GitHub 也可以在创建项目时选「直接上传」，把 `site/` 文件夹
> （不含 `DEPLOY.md` 和 `edge-functions/`）拖进去。缺点是以后更新要手动重传。

## 4. 以后怎么发新版（固定两步）

1. **GitHub**：照常打 tag 发 Release（你已有的流程）。
2. **COS**：把新安装包上传到存储桶，文件名与 GitHub Release 一致。

完成。网页上的版本号、大小、下载按钮、GitHub 下载次数都会在
30 分钟内自动更新（做了缓存，防止 GitHub API 限流）。想立刻看到变化，
用无痕窗口打开网页即可。

## 5. （可选）开启全渠道下载计数

默认只展示 GitHub 的下载数（走 GitHub 按钮的自动统计）。
想连「高速下载」按钮的点击也统计：

1. EdgeOne Pages 控制台 → 你的项目 → **函数 / 边缘函数** → 新建，
   路由填 `/api/dl`，把 `site/edge-functions/dl.js` 的内容粘贴进去，保存。
2. 按提示**绑定 KV 存储**（用默认命名空间）。
3. 把 `config.js` 的 `counterEndpoint` 填为 `"https://xxx.edgeone.app/api/dl"`（换成你的域名）。
4. 重新部署。之后访问 `https://xxx.edgeone.app/api/dl?stats=1` 可随时查看各按钮计数，
   网页上的「累计」数字也会自动合并两个渠道。

## 6. （可选）绑定自己的域名

- **买域名**：腾讯云「域名注册」直接买（微信支付），`.com` 首年约 60–80 元。
- **绑定**：EdgeOne Pages → 项目设置 → 添加自定义域名 → 按提示加 CNAME。
- **备案**：只有当自定义域名要启用**中国大陆节点加速**时才需要 ICP 备案
  （腾讯云备案系统在线办理，免费，约 1–3 周）。默认的 `*.edgeone.app` 域名
  和海外加速节点都不需要备案。可以先用默认域名上线，备案慢慢办。

## 7. 常见问题

- **网页版本号没更新？** 有 30 分钟缓存；无痕窗口验证。GitHub API 匿名限额
  是每 IP 每小时 60 次，本站已做本地缓存，正常使用碰不到限额。
- **「高速下载」点了没反应/404？** COS 里的文件名和 GitHub Release 不一致，
  或 `cosBase` 填错（不要带最后那个文件名，也不要以 `/` 结尾）。
- **COS 流量异常？** 控制台「存储桶 → 数据统计」看明细，必要时开启 Referer
  白名单（注意别挡住下载器，先观察再限）。
- **想改网页文案/截图？** 都在 `site/` 里改完 push 即自动部署；截图放
  `site/assets/img/`，演示视频放 `site/assets/video/` 后在 HTML 里引用。
- **SmartScreen 拦截安装包？** 正常现象（未购买代码签名证书），
  「更多信息 → 仍要运行」。

## 上线检查清单

- [ ] 腾讯云实名认证完成
- [ ] COS 存储桶建好，安装包已上传，文件名与 Release 一致
- [ ] `config.js` 的 `cosBase` 已填，网页上「高速下载」按钮出现且能下载
- [ ] EdgeOne Pages 项目已创建，`*.edgeone.app` 域名国内可打开
- [ ] 网页上版本号 / 大小 / 下载次数与 GitHub 一致
- [ ] （可选）计数函数部署，`?stats=1` 返回 JSON
- [ ] （可选）自定义域名 + 备案
