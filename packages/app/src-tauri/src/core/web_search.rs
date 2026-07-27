//! AI 对话网络搜索：支持多种搜索 Provider。
//! - 内置引擎（免配置）：Bing → 百度 → DuckDuckGo（HTML 爬取，不稳定但零门槛）
//! - API Provider（用户配置 Key）：Tavily / Serper / SearXNG（稳定、高质量）

use serde::{Deserialize, Serialize};

/// 单条搜索结果
#[derive(Serialize, Debug, Clone)]
pub struct WebSearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// percent-decode（DDG 跳转链接 uddg 参数是百分号编码的）
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &input[i + 1..i + 3];
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        // '+' 在 query string 里代表空格
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// 反转义常见 HTML 实体（DDG 的标题/摘要里会出现）
fn unescape_html(input: &str) -> String {
    input
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

/// 从 DDG 跳转链接里提取真实 URL（uddg 参数），提取失败则原样返回
fn extract_real_url(href: &str) -> String {
    if let Some(pos) = href.find("uddg=") {
        let rest = &href[pos + 5..];
        let encoded = rest.split('&').next().unwrap_or(rest);
        let decoded = percent_decode(encoded);
        if !decoded.is_empty() {
            return decoded;
        }
    }
    href.to_string()
}

/// 从 <a ...>...</a> 片段里取出标签内的纯文本
fn tag_inner_text(fragment: &str) -> String {
    // 去掉内部可能嵌套的 <b> 等高亮标签
    let mut out = String::new();
    let mut in_tag = false;
    for ch in fragment.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    unescape_html(out.trim()).to_string()
}

/// 解析 DDG HTML 结果页，提取 title/url/snippet 列表
fn parse_ddg_html(html: &str, max_results: usize) -> Vec<WebSearchResult> {
    let mut results = Vec::new();

    // 每个结果块以 class="result__a" 的链接为锚点
    let mut search_from = 0;
    while results.len() < max_results {
        let Some(a_pos) = html[search_from..].find("result__a") else {
            break;
        };
        let a_abs = search_from + a_pos;

        // 向前找 <a 起点，向后找 </a> 终点
        let tag_start = html[..a_abs].rfind("<a").unwrap_or(a_abs);
        let Some(tag_end_rel) = html[a_abs..].find("</a>") else {
            break;
        };
        let tag_end = a_abs + tag_end_rel;
        let anchor = &html[tag_start..tag_end];

        // 提取 href
        let href = anchor
            .find("href=\"")
            .map(|p| {
                let rest = &anchor[p + 6..];
                rest.find('"').map(|q| &rest[..q]).unwrap_or("")
            })
            .unwrap_or("");

        // 标题：href 之后、</a> 之前的文本
        let title_raw = anchor
            .find('>')
            .map(|p| &anchor[p + 1..])
            .unwrap_or("");
        let title = tag_inner_text(title_raw);

        // 摘要：从结果块往后找 result__snippet
        let snippet = html[tag_end..]
            .find("result__snippet")
            .and_then(|sp| {
                let snip_abs = tag_end + sp;
                html[snip_abs..].find("</a>").map(|e| {
                    let frag_start = html[..snip_abs].rfind('>').map(|p| p + 1).unwrap_or(snip_abs);
                    tag_inner_text(&html[frag_start..snip_abs + e])
                })
            })
            .unwrap_or_default();

        let url = extract_real_url(href);
        if !title.is_empty() && !url.is_empty() {
            results.push(WebSearchResult { title, url, snippet });
        }

        search_from = tag_end + 4;
    }

    results
}

/// 解析 Bing HTML 结果页（结果块为 <li class="b_algo">），提取 title/url/snippet
fn parse_bing_html(html: &str, max_results: usize) -> Vec<WebSearchResult> {
    let mut results = Vec::new();
    let mut search_from = 0;

    while results.len() < max_results {
        let Some(pos) = html[search_from..].find("b_algo") else {
            break;
        };
        let block_start = search_from + pos;
        // 块范围：到下一个 b_algo 或页尾
        let block_end = html[block_start + 6..]
            .find("b_algo")
            .map(|p| block_start + 6 + p)
            .unwrap_or(html.len());
        let block = &html[block_start..block_end];

        // 提取第一个 href（标题链接）
        let href = block
            .find("href=\"")
            .map(|p| {
                let rest = &block[p + 6..];
                rest.find('"').map(|q| &rest[..q]).unwrap_or("")
            })
            .unwrap_or("");

        // 标题：href 所在 <a> 的开标签之后、</a> 之前的文本
        let title = block
            .find("href=\"")
            .and_then(|p| block[p..].find('>'))
            .map(|gt| {
                let after_open = block.split_at(block.find("href=\"").unwrap() + gt + 1).1;
                after_open
                    .find("</a>")
                    .map(|end| tag_inner_text(&after_open[..end]))
                    .unwrap_or_default()
            })
            .unwrap_or_default();

        // 摘要：块内第一个 <p>...</p>
        let snippet = block
            .find("<p")
            .and_then(|p| {
                let rest = &block[p..];
                rest.find('>').and_then(|gt| {
                    let after = &rest[gt + 1..];
                    after.find("</p>").map(|end| tag_inner_text(&after[..end]))
                })
            })
            .unwrap_or_default();

        if !title.is_empty() && !href.is_empty() && href.starts_with("http") {
            results.push(WebSearchResult {
                title,
                url: href.to_string(),
                snippet,
            });
        }

        search_from = block_start + 6;
    }

    results
}

/// 常见本地代理端口（直连失败时逐个尝试，兼容 Clash/V2Ray 等默认配置）
const FALLBACK_PROXIES: [&str; 4] = [
    "http://127.0.0.1:7897",
    "http://127.0.0.1:7890",
    "http://127.0.0.1:10809",
    "http://127.0.0.1:1080",
];

const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/// 发送 GET 请求：先走默认客户端（系统代理/直连），失败后逐个尝试本地代理
async fn fetch_with_proxy_fallback(url: &str) -> Result<reqwest::Response, String> {
    // 1. 默认客户端（reqwest 自动识别系统代理与 HTTPS_PROXY 环境变量）
    if let Ok(client) = reqwest::Client::builder().user_agent(USER_AGENT).build() {
        if let Ok(resp) = client.get(url).send().await {
            return Ok(resp);
        }
    }

    // 2. 直连失败（如 DuckDuckGo 被墙），逐个尝试本地代理
    let mut last_err = String::from("未知错误");
    for proxy_url in FALLBACK_PROXIES {
        let Ok(proxy) = reqwest::Proxy::all(proxy_url) else {
            continue;
        };
        let Ok(client) = reqwest::Client::builder()
            .proxy(proxy)
            .user_agent(USER_AGENT)
            .build()
        else {
            continue;
        };
        match client.get(url).send().await {
            Ok(resp) => return Ok(resp),
            Err(e) => last_err = format!("{proxy_url}: {e}"),
        }
    }

    Err(format!("网络搜索请求失败（直连与本地代理均不可用）: {last_err}"))
}

/// 解析百度 HTML 结果页（结果块以 c-container 为界），提取 title/url/snippet
/// 百度的 href 是跳转链接（baidu.com/link?url=...），原样保留（点击会重定向到真实页面）
fn parse_baidu_html(html: &str, max_results: usize) -> Vec<WebSearchResult> {
    let mut results = Vec::new();
    let mut search_from = 0;

    while results.len() < max_results {
        let Some(pos) = html[search_from..].find("c-container") else {
            break;
        };
        let block_start = search_from + pos;
        // 块范围：到下一个 c-container 或页尾
        let block_end = html[block_start + 11..]
            .find("c-container")
            .map(|p| block_start + 11 + p)
            .unwrap_or(html.len());
        let block = &html[block_start..block_end];

        // 标题与链接：<h3 ...><a href="...">标题</a></h3>
        let Some(h3_pos) = block.find("<h3") else {
            search_from = block_start + 11;
            continue;
        };
        let after_h3 = &block[h3_pos..];
        let href = after_h3
            .find("href=\"")
            .map(|p| {
                let rest = &after_h3[p + 6..];
                rest.find('"').map(|q| &rest[..q]).unwrap_or("")
            })
            .unwrap_or("");
        let title = after_h3
            .find('>')
            .and_then(|gt| {
                let after_open = &after_h3[gt + 1..];
                after_open.find("</a>").map(|end| tag_inner_text(&after_open[..end]))
            })
            .unwrap_or_default();

        // 摘要：优先 content-right_ 前缀的 span，找不到则留空（best-effort）
        let snippet = block
            .find("content-right_")
            .and_then(|p| {
                let rest = &block[p..];
                rest.find('>').and_then(|gt| {
                    let after = &rest[gt + 1..];
                    after.find("</span>").map(|end| tag_inner_text(&after[..end]))
                })
            })
            .unwrap_or_default();

        if !title.is_empty() && !href.is_empty() {
            results.push(WebSearchResult {
                title,
                url: href.to_string(),
                snippet,
            });
        }

        search_from = block_start + 11;
    }

    results
}

/// 必应搜索（国内可直连，免代理）
async fn search_bing(query: &str, max: usize) -> Result<Vec<WebSearchResult>, String> {
    let url = format!("https://www.bing.com/search?q={}&setlang=zh-hans", urlencode(query));
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let resp = client.get(&url).send().await.map_err(|e| format!("必应请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("必应搜索失败 (HTTP {})", resp.status()));
    }
    let html = resp.text().await.map_err(|e| format!("读取必应结果失败: {e}"))?;
    Ok(parse_bing_html(&html, max))
}

/// 百度搜索（国内可直连，免代理）
async fn search_baidu(query: &str, max: usize) -> Result<Vec<WebSearchResult>, String> {
    let url = format!("https://www.baidu.com/s?wd={}&rn={}", urlencode(query), max);
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let resp = client.get(&url).send().await.map_err(|e| format!("百度请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("百度搜索失败 (HTTP {})", resp.status()));
    }
    let html = resp.text().await.map_err(|e| format!("读取百度结果失败: {e}"))?;
    // 识别百度反爬验证页（无真实结果）
    if html.contains("百度安全验证") || html.contains("wappass.baidu.com") {
        return Err("百度触发安全验证（反爬），本次跳过".to_string());
    }
    Ok(parse_baidu_html(&html, max))
}

/// DuckDuckGo 搜索（需代理，作为备选）
async fn search_ddg(query: &str, max: usize) -> Result<Vec<WebSearchResult>, String> {
    let url = format!("https://html.duckduckgo.com/html/?q={}", urlencode(query));
    let resp = fetch_with_proxy_fallback(&url).await?;
    if !resp.status().is_success() {
        return Err(format!("DuckDuckGo 搜索失败 (HTTP {})", resp.status()));
    }
    let html = resp.text().await.map_err(|e| format!("读取 DuckDuckGo 结果失败: {e}"))?;
    Ok(parse_ddg_html(&html, max))
}

// ─── API Provider 响应结构 ───────────────────────────────────────────────────

/// Tavily API 响应
#[derive(Deserialize)]
struct TavilyResponse {
    results: Vec<TavilyResult>,
}

#[derive(Deserialize)]
struct TavilyResult {
    title: String,
    url: String,
    content: String,
}

/// Serper API 响应
#[derive(Deserialize)]
struct SerperResponse {
    organic: Option<Vec<SerperResult>>,
}

#[derive(Deserialize)]
struct SerperResult {
    title: String,
    link: String,
    snippet: Option<String>,
}

/// SearXNG JSON API 响应
#[derive(Deserialize)]
struct SearxngResponse {
    results: Vec<SearxngResult>,
}

#[derive(Deserialize)]
struct SearxngResult {
    title: String,
    url: String,
    content: Option<String>,
}

/// 博查 Web Search API 响应
#[derive(Deserialize)]
struct BochaResponse {
    data: Option<BochaData>,
}

#[derive(Deserialize)]
struct BochaData {
    #[serde(rename = "webPages")]
    web_pages: Option<BochaWebPages>,
}

#[derive(Deserialize)]
struct BochaWebPages {
    value: Vec<BochaResult>,
}

#[derive(Deserialize)]
struct BochaResult {
    name: String,
    url: String,
    snippet: Option<String>,
}

/// 智谱 Web Search API 响应
#[derive(Deserialize)]
struct ZhipuSearchResponse {
    choices: Option<Vec<ZhipuChoice>>,
}

#[derive(Deserialize)]
struct ZhipuChoice {
    message: Option<ZhipuMessage>,
}

#[derive(Deserialize)]
struct ZhipuMessage {
    tool_calls: Option<Vec<ZhipuToolCall>>,
}

#[derive(Deserialize)]
struct ZhipuToolCall {
    #[serde(rename = "type")]
    call_type: Option<String>,
    search_result: Option<Vec<ZhipuSearchResult>>,
}

#[derive(Deserialize)]
struct ZhipuSearchResult {
    title: String,
    link: String,
    content: Option<String>,
}

// ─── API Provider 搜索实现 ───────────────────────────────────────────────────

/// Tavily 搜索（专为 AI Agent 优化的搜索 API）
async fn search_tavily(query: &str, max: usize, api_key: &str) -> Result<Vec<WebSearchResult>, String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let body = serde_json::json!({
        "api_key": api_key,
        "query": query,
        "max_results": max,
        "search_depth": "basic",
    });

    let resp = client
        .post("https://api.tavily.com/search")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Tavily 请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Tavily 搜索失败 (HTTP {status}): {text}"));
    }

    let data: TavilyResponse = resp.json().await.map_err(|e| format!("解析 Tavily 响应失败: {e}"))?;
    Ok(data
        .results
        .into_iter()
        .map(|r| WebSearchResult {
            title: r.title,
            url: r.url,
            snippet: r.content,
        })
        .collect())
}

/// Serper 搜索（Google 搜索结果 API）
async fn search_serper(query: &str, max: usize, api_key: &str) -> Result<Vec<WebSearchResult>, String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let body = serde_json::json!({
        "q": query,
        "num": max,
    });

    let resp = client
        .post("https://google.serper.dev/search")
        .header("X-API-KEY", api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Serper 请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Serper 搜索失败 (HTTP {status}): {text}"));
    }

    let data: SerperResponse = resp.json().await.map_err(|e| format!("解析 Serper 响应失败: {e}"))?;
    Ok(data
        .organic
        .unwrap_or_default()
        .into_iter()
        .map(|r| WebSearchResult {
            title: r.title,
            url: r.link,
            snippet: r.snippet.unwrap_or_default(),
        })
        .collect())
}

/// SearXNG 搜索（自托管元搜索引擎，JSON API）
async fn search_searxng(query: &str, max: usize, base_url: &str) -> Result<Vec<WebSearchResult>, String> {
    let base = base_url.trim_end_matches('/');
    let url = format!(
        "{base}/search?q={}&format=json&categories=general",
        urlencode(query)
    );

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("SearXNG 请求失败（请确认服务已启动）: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        return Err(format!("SearXNG 搜索失败 (HTTP {status})"));
    }

    let data: SearxngResponse = resp.json().await.map_err(|e| format!("解析 SearXNG 响应失败: {e}"))?;
    Ok(data
        .results
        .into_iter()
        .take(max)
        .map(|r| WebSearchResult {
            title: r.title,
            url: r.url,
            snippet: r.content.unwrap_or_default(),
        })
        .collect())
}

/// 博查搜索（国内 AI 搜索 API，DeepSeek 等 60%+ 国内 AI 应用采用）
async fn search_bocha(query: &str, max: usize, api_key: &str) -> Result<Vec<WebSearchResult>, String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let body = serde_json::json!({
        "query": query,
        "count": max,
        "summary": true,
    });

    let resp = client
        .post("https://api.bochaai.com/v1/web-search")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("博查请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("博查搜索失败 (HTTP {status}): {text}"));
    }

    let data: BochaResponse = resp.json().await.map_err(|e| format!("解析博查响应失败: {e}"))?;
    let pages = data
        .data
        .and_then(|d| d.web_pages)
        .map(|p| p.value)
        .unwrap_or_default();
    Ok(pages
        .into_iter()
        .map(|r| WebSearchResult {
            title: r.name,
            url: r.url,
            snippet: r.snippet.unwrap_or_default(),
        })
        .collect())
}

/// 智谱 Web Search Pro（国内可靠，支持多引擎）
async fn search_zhipu(query: &str, max: usize, api_key: &str) -> Result<Vec<WebSearchResult>, String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let body = serde_json::json!({
        "tool": "web-search-pro",
        "stream": false,
        "message": [{"role": "user", "content": query}],
    });

    let resp = client
        .post("https://open.bigmodel.cn/api/paas/v4/tools")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("智谱搜索请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("智谱搜索失败 (HTTP {status}): {text}"));
    }

    let data: ZhipuSearchResponse = resp.json().await.map_err(|e| format!("解析智谱响应失败: {e}"))?;

    // 从嵌套结构中提取搜索结果
    let results: Vec<WebSearchResult> = data
        .choices
        .unwrap_or_default()
        .into_iter()
        .filter_map(|c| c.message)
        .filter_map(|m| m.tool_calls)
        .flatten()
        .filter(|tc| tc.call_type.as_deref() == Some("search_result"))
        .filter_map(|tc| tc.search_result)
        .flatten()
        .take(max)
        .map(|r| WebSearchResult {
            title: r.title,
            url: r.link,
            snippet: r.content.unwrap_or_default(),
        })
        .collect();

    Ok(results)
}

// ─── Tauri Command ───────────────────────────────────────────────────────────

/// 网络搜索 Tauri command
///
/// provider："builtin" | "bocha" | "zhipu" | "tavily" | "serper" | "searxng"
/// engine：仅 builtin 模式下有效，"auto" | "bing" | "baidu" | "duckduckgo"
#[tauri::command]
pub async fn web_search(
    query: String,
    max_results: Option<usize>,
    engine: Option<String>,
    provider: Option<String>,
    api_key: Option<String>,
    searxng_url: Option<String>,
) -> Result<Vec<WebSearchResult>, String> {
    let max = max_results.unwrap_or(6).clamp(1, 20);
    let provider = provider.unwrap_or_else(|| "builtin".to_string());

    // ── API Provider 路径 ──
    match provider.as_str() {
        "bocha" => {
            let key = api_key.filter(|k| !k.trim().is_empty())
                .ok_or_else(|| "博查需要 API Key，请在设置 → 网络搜索中配置".to_string())?;
            let results = search_bocha(&query, max, key.trim()).await?;
            if results.is_empty() {
                return Err("博查未返回搜索结果".to_string());
            }
            log::info!("[网络搜索] 博查返回 {} 条结果", results.len());
            return Ok(results);
        }
        "zhipu" => {
            let key = api_key.filter(|k| !k.trim().is_empty())
                .ok_or_else(|| "智谱需要 API Key，请在设置 → 网络搜索中配置".to_string())?;
            let results = search_zhipu(&query, max, key.trim()).await?;
            if results.is_empty() {
                return Err("智谱未返回搜索结果".to_string());
            }
            log::info!("[网络搜索] 智谱返回 {} 条结果", results.len());
            return Ok(results);
        }
        "tavily" => {
            let key = api_key.filter(|k| !k.trim().is_empty())
                .ok_or_else(|| "Tavily 需要 API Key，请在设置 → 网络搜索中配置".to_string())?;
            let results = search_tavily(&query, max, key.trim()).await?;
            if results.is_empty() {
                return Err("Tavily 未返回搜索结果".to_string());
            }
            log::info!("[网络搜索] Tavily 返回 {} 条结果", results.len());
            return Ok(results);
        }
        "serper" => {
            let key = api_key.filter(|k| !k.trim().is_empty())
                .ok_or_else(|| "Serper 需要 API Key，请在设置 → 网络搜索中配置".to_string())?;
            let results = search_serper(&query, max, key.trim()).await?;
            if results.is_empty() {
                return Err("Serper 未返回搜索结果".to_string());
            }
            log::info!("[网络搜索] Serper 返回 {} 条结果", results.len());
            return Ok(results);
        }
        "searxng" => {
            let url = searxng_url.filter(|u| !u.trim().is_empty())
                .ok_or_else(|| "SearXNG 需要填写服务地址，请在设置 → 网络搜索中配置".to_string())?;
            let results = search_searxng(&query, max, url.trim()).await?;
            if results.is_empty() {
                return Err("SearXNG 未返回搜索结果".to_string());
            }
            log::info!("[网络搜索] SearXNG 返回 {} 条结果", results.len());
            return Ok(results);
        }
        _ => {} // fallback to builtin
    }

    // ── 内置引擎路径（HTML 爬取） ──
    let engine = engine.unwrap_or_else(|| "auto".to_string());
    let engines: Vec<&str> = match engine.as_str() {
        "bing" => vec!["bing"],
        "baidu" => vec!["baidu"],
        "duckduckgo" => vec!["duckduckgo"],
        _ => vec!["bing", "baidu", "duckduckgo"], // auto 轮询
    };

    let mut last_err = String::from("未知错误");
    for eng in engines {
        let result = match eng {
            "bing" => search_bing(&query, max).await,
            "baidu" => search_baidu(&query, max).await,
            "duckduckgo" => search_ddg(&query, max).await,
            _ => continue,
        };
        match result {
            Ok(results) if !results.is_empty() => {
                log::info!("[网络搜索] 引擎 {eng} 返回 {} 条结果", results.len());
                return Ok(results);
            }
            Ok(_) => {
                log::info!("[网络搜索] 引擎 {eng} 无结果");
                last_err = format!("{eng}: 未找到相关结果");
            }
            Err(e) => {
                log::warn!("[网络搜索] 引擎 {eng} 失败: {e}");
                last_err = format!("{eng}: {e}");
            }
        }
    }

    Err(format!(
        "网络搜索失败（{last_err}）。建议在设置 → 网络搜索中配置博查/智谱 API Key 以获得稳定体验。"
    ))
}

/// 简单的 query 参数编码（空格与常见特殊字符）
fn urlencode(input: &str) -> String {
    let mut out = String::new();
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_percent_decode() {
        assert_eq!(percent_decode("https%3A%2F%2Fa.com%2Fb"), "https://a.com/b");
        assert_eq!(percent_decode("hello+world"), "hello world");
    }

    #[test]
    fn test_extract_real_url() {
        let href = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc";
        assert_eq!(extract_real_url(href), "https://example.com/page");
    }

    #[test]
    fn test_unescape_html() {
        assert_eq!(unescape_html("A &amp; B &lt;C&gt;"), "A & B <C>");
    }

    #[test]
    fn test_parse_baidu_html() {
        let html = r#"<div id="content_left"><div class="result c-container new-pmd" id="1"><h3 class="t"><a href="http://www.baidu.com/link?url=abc123" target="_blank">Rust <em>语言</em>教程</a></h3><div class="c-row"><span class="content-right_8Zs40">Rust 是一门系统级编程语言，&amp; 性能出色。</span></div></div><div class="result c-container" id="2"><h3 class="t"><a href="http://www.baidu.com/link?url=def456">第二个结果</a></h3><div>无摘要</div></div></div>"#;
        let results = parse_baidu_html(html, 6);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Rust 语言教程");
        assert_eq!(results[0].url, "http://www.baidu.com/link?url=abc123");
        assert_eq!(results[0].snippet, "Rust 是一门系统级编程语言，& 性能出色。");
        assert_eq!(results[1].title, "第二个结果");
        assert_eq!(results[1].snippet, "");
    }

    #[test]
    fn test_parse_bing_html() {
        let html = r#"<ol><li class="b_algo"><h2><a href="https://example.com/page">Rust <strong>Lang</strong></a></h2><div class="b_caption"><p>A systems language &amp; more</p></div></li><li class="b_algo"><h2><a href="https://b.com">Second</a></h2><p>Another snippet</p></li></ol>"#;
        let results = parse_bing_html(html, 6);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Rust Lang");
        assert_eq!(results[0].url, "https://example.com/page");
        assert_eq!(results[0].snippet, "A systems language & more");
        assert_eq!(results[1].title, "Second");
        assert_eq!(results[1].snippet, "Another snippet");
    }

    #[test]
    fn test_parse_ddg_html() {
        let html = r#"<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&rut=x">Rust <b>Lang</b></a><a class="result__snippet">A systems language &amp; more</a></div>"#;
        let results = parse_ddg_html(html, 6);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Rust Lang");
        assert_eq!(results[0].url, "https://example.com");
        assert_eq!(results[0].snippet, "A systems language & more");
    }
}
