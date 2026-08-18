/* 下载计数边缘函数（腾讯 EdgeOne Pages，可选启用）
 *
 * 作用：页面上的下载按钮被点击时，浏览器向本函数发一个轻量请求（sendBeacon），
 *       函数在 KV 里把对应产品的计数 +1。带 ?stats=1 访问则返回全部计数 JSON。
 * 不做跳转、不收集 IP/UA，只维护「产品 id → 次数」。
 *
 * 部署：EdgeOne Pages 控制台 → 你的项目 → 函数（边缘函数）→ 新建，
 *       路由填 /api/dl，粘贴本文件内容，保存并绑定 KV 存储（默认命名空间即可）。
 *       然后把 site/assets/js/config.js 的 counterEndpoint 填成
 *       "https://<你的站点域名>/api/dl"。详见 DEPLOY.md 第 5 步。
 *
 * KV API 说明（EdgeOne 边缘函数内置）：
 *   await navigator.storage.get(key)   → 返回字符串或 null
 *   await navigator.storage.put(key, value)
 */

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  });
}

async function handleRequest(request) {
  const url = new URL(request.url);

  /* 汇总查询：GET /api/dl?stats=1 → {"sageread-setup":12,...} */
  if (url.searchParams.get("stats") === "1") {
    const raw = await navigator.storage.get("dl:all");
    return json(raw ? JSON.parse(raw) : {});
  }

  /* 计数：GET/POST /api/dl?id=sageread-setup */
  const id = url.searchParams.get("id");
  if (!id || !/^[a-z0-9-]{1,64}$/i.test(id)) return json({ error: "bad id" }, 400);

  const allKey = "dl:all";
  const all = JSON.parse((await navigator.storage.get(allKey)) || "{}");
  all[id] = (all[id] || 0) + 1;
  await navigator.storage.put(allKey, JSON.stringify(all));

  return json({ ok: true, count: all[id] });
}

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});
