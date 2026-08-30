/* ============================================================
 * 站点配置 —— 发新版/换存储桶时只需要改这一个文件
 * ============================================================ */
window.SITE_CONFIG = {

  /* 国内高速下载基地址（腾讯云 COS 存储桶默认域名）。
   * 部署好 COS 后把整段引号填成类似：
   *   "https://sageread-1250000000.cos.ap-guangzhou.myqcloud.com"
   * 留空（默认）时，页面只显示 GitHub 直连按钮，网站照常可用。
   * 详细步骤见 DEPLOY.md 第 2 步。若配置了防烧流量（DEPLOY.md 第 6 步），
   * 此处应换成 EdgeOne 加速域名（如 https://dl.bettersageread.cn）让防护规则生效。 */
  cosBase: "https://sageread-dl-1444623537.cos.ap-guangzhou.myqcloud.com",

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
          version: "v0.2.1",
          size: "135.6 MB",
          count: 4,
          url: "https://github.com/Feplus2/better-sageread/releases/download/v0.2.1/Better.SageRead_0.2.1_x64-setup.exe",
        },
        {
          id: "msi",
          pick: "x64_en-US.msi",
          label: "MSI 安装包",
          version: "v0.2.1",
          size: "138.5 MB",
          count: 0,
          url: "https://github.com/Feplus2/better-sageread/releases/download/v0.2.1/Better.SageRead_0.2.1_x64_en-US.msi",
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
          version: "v1.3.3",
          size: "63.3 MB",
          count: 5,
          url: "https://github.com/Feplus2/Books_Converter/releases/download/v1.3.3/Books_Converter-v1.3.3-win64.zip",
        },
        {
          id: "cli",
          pick: "-cli-",
          label: "命令行 CLI 版",
          version: "v1.3.3",
          size: "57.7 MB",
          count: 2,
          url: "https://github.com/Feplus2/Books_Converter/releases/download/v1.3.3/books_converter-cli-v1.3.3-win64.zip",
        },
      ],
    },

    /* 以下三个为纯源码组件：下载表里是硬编码的仓库/npm 直链（无安装包、
     * 不传 COS），repo 保持 null——app.js 的 applyProduct 依赖 assets 数组，
     * 源码行没有资产可匹配，置空即跳过动态逻辑。status 仅作占位备注。 */
    "papers-converter": {
      repo: null,
      status: "源码发布（pip / git 安装）",
    },

    "sageread-mcp": {
      repo: null,
      status: "npm 包（npx 直跑）",
    },

    "zotero-brain-slim": {
      repo: null,
      status: "v1.0.0 源码发布（uvx 直跑）",
    },
  },
};
