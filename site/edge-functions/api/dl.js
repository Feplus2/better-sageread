/* 下载计数边缘函数（EdgeOne Makers / Pages，随仓库 push 自动部署）
 *
 * 路由：Makers 按项目根目录下 /edge-functions 的文件结构生成路由，
 *   本文件 site/edge-functions/api/dl.js → https://<站点域名>/api/dl
 *   （Pages 项目的根目录是 site/，故路径正好是 /api/dl）
 *
 * 作用：页面下载按钮被点击时，浏览器向本函数发轻量请求（sendBeacon/fetch），
 *   函数在 KV 里把对应产品的计数 +1；GET ?stats=1 返回全部计数 JSON。
 *   不做跳转、不收集 IP/UA，只维护「产品 id → 次数」。
 *
 * 一次性配置（Makers 控制台，代码无需再动）：
 *   1. 控制台顶部导航 → KV Storage → Apply now（需填写用途申请，待审批通过）
 *   2. Create Namespace（名称随意，如 sageread-site）
 *   3. 进入本项目 → 左侧 KV Storage → Bind Namespace，
 *      变量名必须填 DL_KV（代码按此名读取）
 *   4. 把 site/assets/js/config.js 的 counterEndpoint 填成
 *      "https://<你的站点域名>/api/dl"
 * 详见 DEPLOY.md 第 5 步。
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

async function handle(request, env) {
  const kv = env && env.DL_KV;
  if (!kv) return json({ error: "KV binding DL_KV 未配置（控制台绑定命名空间后生效）" }, 500);

  const url = new URL(request.url);

  /* 汇总查询：GET /api/dl?stats=1 → {"sageread-setup":12,...} */
  if (url.searchParams.get("stats") === "1") {
    const raw = await kv.get("dl:all");
    return json(raw ? JSON.parse(raw) : {});
  }

  /* 计数：GET/POST /api/dl?id=sageread-setup */
  const id = url.searchParams.get("id");
  if (!id || !/^[a-z0-9-]{1,64}$/i.test(id)) return json({ error: "bad id" }, 400);

  const all = JSON.parse((await kv.get("dl:all")) || "{}");
  all[id] = (all[id] || 0) + 1;
  await kv.put("dl:all", JSON.stringify(all));

  return json({ ok: true, count: all[id] });
}

/* Makers 仅支持 Function Handlers，不支持 addEventListener */
export function onRequest(context) {
  return handle(context.request, context.env);
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
