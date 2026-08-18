/* ============================================================
 * 站点配置 —— 发新版/换存储桶时只需要改这一个文件
 * ============================================================ */
window.SITE_CONFIG = {

  /* 国内高速下载基地址（腾讯云 COS 存储桶默认域名）。
   * 部署好 COS 后把整段引号填成类似：
   *   "https://sageread-1250000000.cos.ap-guangzhou.myqcloud.com"
   * 留空（默认）时，页面只显示 GitHub 直连按钮，网站照常可用。
   * 详细步骤见 DEPLOY.md 第 2 步。 */
  cosBase: "",

  /* 下载计数边缘函数地址（可选）。部署 edge-functions/dl.js 后填，
   * 如 "https://xxx.edgeone.app/api/dl"。留空则不统计「高速下载」点击，
   * 页面仍会显示 GitHub 的真实下载数。见 DEPLOY.md 第 5 步。 */
  counterEndpoint: "",

  /* 各产品的发布信息。repo 有值时会自动拉取 GitHub 最新版本号、
   * 文件大小与下载次数，并自动更新下载链接（无需改 HTML）。
   * pick 是资产文件名的结尾匹配词，用于在 Release 里挑出对应安装包。
   * 新产品发布后，把 repo/status 补上即可。 */
  products: {
    "sageread": {
      repo: "Feplus2/better-sageread",
      assets: [
        {
          id: "setup",
          pick: "-setup.exe",
          label: "安装版 setup.exe（推荐）",
          version: "v0.2.0",
          size: "135.5 MB",
          count: 4,
          url: "https://github.com/Feplus2/better-sageread/releases/download/v0.2.0/Better.SageRead_0.2.0_x64-setup.exe",
        },
        {
          id: "msi",
          pick: "x64_en-US.msi",
          label: "MSI 安装包",
          version: "v0.2.0",
          size: "138.4 MB",
          count: 0,
          url: "https://github.com/Feplus2/better-sageread/releases/download/v0.2.0/Better.SageRead_0.2.0_x64_en-US.msi",
        },
      ],
    },

    "books-converter": {
      repo: "Feplus2/Books_Converter",
      assets: [
        {
          id: "gui",
          pick: "Converter-v",
          label: "图形界面版（推荐）",
          version: "v1.3",
          size: "62.0 MB",
          count: 5,
          url: "https://github.com/Feplus2/Books_Converter/releases/download/v1.3/Books_Converter-v1.3-win64.zip",
        },
        {
          id: "cli",
          pick: "-cli-",
          label: "命令行 CLI 版",
          version: "v1.3",
          size: "57.7 MB",
          count: 2,
          url: "https://github.com/Feplus2/Books_Converter/releases/download/v1.3/books_converter-cli-v1.3-win64.zip",
        },
      ],
    },

    "papers-converter": {
      repo: null,          /* 发布后改成 "Feplus2/Papers_Converter" */
      status: "开源准备中",
    },

    "sageread-mcp": {
      repo: null,          /* 发布后改成 "Feplus2/sageread-mcp" */
      status: "开源准备中",
    },

    "zotero-brain-slim": {
      repo: null,          /* 发布后改成 "Feplus2/zotero-brain-slim"（或对应仓库） */
      status: "发布准备中",
    },
  },
};
