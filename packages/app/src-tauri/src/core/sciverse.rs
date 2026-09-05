//! Sciverse 科研搜索（OpenDataLab 科学证据数据层）：学术语义检索，返回论文全文证据片段。
//! 与 web_search（通用网页搜索）并列独立——学术/科研问答走这里，新闻资讯等通用网页检索走 web_search。
//!
//! API 契约（https://api.sciverse.space，Bearer Token 鉴权）：
//! - POST /agentic-search  语义检索，hits 带 doc_id/offset/page_no（证据在原文中的坐标）
//! - GET  /content         按字节区间读原文 Markdown 切片（expand 时对 top 命中扩读上下文）

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const API_BASE: &str = "https://api.sciverse.space";
/// quality 模式服务端 LLM 改写 + 混合召回，实测 2-4s，留足余量
const TIMEOUT_SECS: u64 = 30;

/// 返回给前端的证据片段（camelCase 与前端 TS 接口对齐）
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SciverseEvidence {
    pub title: String,
    pub doc_id: String,
    pub chunk_id: String,
    pub score: f64,
    /// 证据在原文中的字节偏移（read_content 可直接用）
    pub offset: i64,
    /// 证据在 PDF 中的页码（可能缺失）
    pub page_no: Option<i64>,
    #[serde(rename = "abstract")]
    pub abstract_text: String,
    /// 命中的原文片段
    pub text: String,
    /// expand=true 时从 offset 起扩读的原文 Markdown 上下文
    pub context: Option<String>,
    pub context_more: Option<bool>,
}

// ---- 上游响应结构（serde 宽松解析，缺字段给默认值） ----

#[derive(Debug, Deserialize)]
struct AgenticSearchResponse {
    #[serde(default)]
    hits: Vec<AgenticHit>,
}

#[derive(Debug, Deserialize)]
struct AgenticHit {
    #[serde(default)]
    chunk_id: String,
    #[serde(default)]
    doc_id: String,
    #[serde(default)]
    title: String,
    #[serde(default, rename = "abstract")]
    abstract_text: String,
    #[serde(default)]
    chunk: String,
    #[serde(default)]
    score: f64,
    #[serde(default)]
    offset: i64,
    page_no: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ReadContentResponse {
    #[serde(default)]
    text: String,
    #[serde(default)]
    more: bool,
}

fn http_client() -> Result<reqwest::Client, String> {
    crate::core::proxy::builder()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))
}

/// 把上游非 2xx 状态翻译成用户可操作的中文提示
fn status_error(action: &str, status: reqwest::StatusCode, body: &str) -> String {
    match status.as_u16() {
        401 => format!("Sciverse Token 缺失或无效（401），请到 设置 → 科研搜索 检查 API Token"),
        429 => format!("Sciverse 配额/限流超限（429），请稍后重试或到 sciverse.space 控制台调整配额"),
        code => format!("Sciverse {action}失败 (HTTP {code}): {}", &body[..body.len().min(200)]),
    }
}

/// GET /content 扩读单条命中的原文上下文（失败静默降级为无 context，不拖垮主检索）
async fn read_context(client: &reqwest::Client, token: &str, doc_id: &str, offset: i64, limit: i64) -> Option<ReadContentResponse> {
    let resp = client
        .get(format!("{API_BASE}/content"))
        .query(&[("doc_id", doc_id), ("offset", &offset.to_string()), ("limit", &limit.to_string())])
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json().await.ok()
}

/// Sciverse 语义证据检索 Tauri command（Token 由 Rust 侧自 keyring 取，不经前端）
#[tauri::command]
pub async fn sciverse_search(
    app: AppHandle,
    query: String,
    top_k: Option<usize>,
    mode: Option<String>,
    expand: Option<bool>,
) -> Result<Vec<SciverseEvidence>, String> {
    let token = crate::core::secrets::get_secret(&app, "sciverse", "token")
        .map_err(|e| format!("读取密钥失败: {e}"))?
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| "Sciverse 需要 API Token，请在 设置 → 科研搜索 中配置".to_string())?;
    let token = token.trim().to_string();

    let top_k = top_k.unwrap_or(8).clamp(1, 30);
    let mode = match mode.as_deref() {
        Some("fast") => "fast",
        Some("quality") => "quality",
        _ => "balanced",
    };

    let client = http_client()?;
    let body = serde_json::json!({
        "query": query.trim(),
        "top_k": top_k,
        "mode": mode,
    });

    let resp = client
        .post(format!("{API_BASE}/agentic-search"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Sciverse 检索请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(status_error("检索", status, &text));
    }

    let data: AgenticSearchResponse = resp
        .json()
        .await
        .map_err(|e| format!("解析 Sciverse 响应失败: {e}"))?;
    if data.hits.is_empty() {
        return Err("Sciverse 未命中相关证据片段（可换用 webSearch 或调整问题表述）".to_string());
    }

    let expand = expand.unwrap_or(false);
    let mut out: Vec<SciverseEvidence> = Vec::with_capacity(data.hits.len());
    for h in data.hits.into_iter() {
        out.push(SciverseEvidence {
            title: h.title,
            doc_id: h.doc_id,
            chunk_id: h.chunk_id,
            score: h.score,
            offset: h.offset,
            page_no: h.page_no,
            abstract_text: h.abstract_text,
            text: h.chunk,
            context: None,
            context_more: None,
        });
    }

    // expand：对前 3 条有 doc_id 的命中扩读原文上下文（各 4096 字节）
    if expand {
        let targets: Vec<usize> = out
            .iter()
            .enumerate()
            .filter(|(_, e)| !e.doc_id.is_empty())
            .take(3)
            .map(|(i, _)| i)
            .collect();
        for i in targets {
            let (doc_id, offset) = (out[i].doc_id.clone(), out[i].offset);
            if let Some(c) = read_context(&client, &token, &doc_id, offset, 4096).await {
                out[i].context = Some(c.text);
                out[i].context_more = Some(c.more);
            }
        }
    }

    log::info!("[科研搜索] Sciverse 返回 {} 条证据（mode={mode}, expand={expand}）", out.len());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 响应解析回归：缺省字段给默认值，camelCase 输出契约稳定
    #[test]
    fn parse_agentic_search_response() {
        let raw = r#"{
            "hits": [{
                "chunk_id": "c1", "doc_id": "d1", "title": "Attention Is All You Need",
                "abstract": "The dominant sequence...", "chunk": "Multi-head attention...",
                "score": 0.91, "offset": 12345, "page_no": 4
            }, {
                "chunk_id": "c2", "doc_id": "d2", "title": "Sparse Record",
                "chunk": "...", "score": 0.5, "offset": 0
            }]
        }"#;
        let data: AgenticSearchResponse = serde_json::from_str(raw).expect("解析失败");
        assert_eq!(data.hits.len(), 2);
        assert_eq!(data.hits[0].title, "Attention Is All You Need");
        assert_eq!(data.hits[0].offset, 12345);
        assert_eq!(data.hits[0].page_no, Some(4));
        // 第二条缺 abstract/page_no：默认空串 / None
        assert_eq!(data.hits[1].abstract_text, "");
        assert_eq!(data.hits[1].page_no, None);
    }

    /// 输出给前端的 JSON 键名契约（camelCase；abstract 不加引号冲突）
    #[test]
    fn evidence_serializes_camel_case() {
        let e = SciverseEvidence {
            title: "t".into(),
            doc_id: "d".into(),
            chunk_id: "c".into(),
            score: 0.9,
            offset: 1,
            page_no: Some(2),
            abstract_text: "a".into(),
            text: "x".into(),
            context: None,
            context_more: None,
        };
        let v = serde_json::to_value(&e).unwrap();
        assert!(v.get("docId").is_some());
        assert!(v.get("pageNo").is_some());
        assert_eq!(v.get("abstract").unwrap(), "a");
    }

    /// 状态码错误提示：401/429 给可操作指引
    #[test]
    fn status_error_messages() {
        let m401 = status_error("检索", reqwest::StatusCode::UNAUTHORIZED, "");
        assert!(m401.contains("设置 → 科研搜索"));
        let m429 = status_error("检索", reqwest::StatusCode::TOO_MANY_REQUESTS, "");
        assert!(m429.contains("配额"));
        let m500 = status_error("检索", reqwest::StatusCode::INTERNAL_SERVER_ERROR, "boom");
        assert!(m500.contains("HTTP 500"));
    }
}
