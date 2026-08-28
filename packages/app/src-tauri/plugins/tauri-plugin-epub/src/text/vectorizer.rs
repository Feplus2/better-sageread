use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tiktoken_rs::o200k_base;

use crate::models::VectorizerConfig;
use crate::text::MAX_CHUNK_TOKENS;

#[derive(Serialize)]
struct OpenAIEmbeddingRequest {
    input: Vec<String>,
    model: String,
    encoding_format: String,
}

#[derive(Serialize)]
struct OllamaEmbeddingRequest {
    model: String,
    input: String,
}

#[derive(Deserialize)]
struct OpenAIEmbeddingResponse {
    data: Vec<EmbeddingData>,
}

#[derive(Deserialize)]
struct OllamaEmbeddingResponse {
    embeddings: Vec<Vec<f32>>,
}

#[derive(Deserialize)]
struct EmbeddingData {
    embedding: Vec<f32>,
}

// Removed Usage: only `data` is required

pub struct TextVectorizer {
    client: Client,
    api_key: Option<String>,
    model_name: String,
    embeddings_url: String,
    tokenizer: tiktoken_rs::CoreBPE,
    /// 缓存检测到的维度（set-once：P3 起 vectorize_text 取 &self 供多路并发 embed，改内部可变性）
    embedding_dimension: std::sync::OnceLock<usize>,
    /// app.db 路径：每次 embed 落一行 ai_usage 流水（kind='embed'，与 LLM 用量分开统计）。
    /// None = 不记账。统计失败只记日志，绝不影响向量化
    usage_db: Option<std::path::PathBuf>,
}



impl TextVectorizer {
    /// 创建新的文本向量化器
    pub async fn new(config: VectorizerConfig) -> Result<Self> {
        log::info!("初始化嵌入 API 向量化器: embeddings_url={}, model={}", config.embeddings_url, config.model_name);

        // 必须带超时：网络抽风时默认 Client 会永久悬挂，批量向量化会整体卡死（真机实证）
        let client = Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .context("Failed to build HTTP client")?;
        let tokenizer = o200k_base().context("Failed to initialize tiktoken tokenizer")?;

        Ok(Self {
            client,
            api_key: config.api_key,
            model_name: config.model_name,
            embeddings_url: config.embeddings_url,
            tokenizer,
            embedding_dimension: std::sync::OnceLock::new(), // 初始化时未知，首次调用时检测
            usage_db: config.usage_db,
        })
    }

    /// 将文本转换为向量（embed HTTP 失败有限指数退避重试：3 次、500ms 起、429 同等对待——P3 §2；
    /// &self：单篇内 4 路并发 embed 共享同一 vectorizer）
    pub async fn vectorize_text(&self, text: &str) -> Result<Vec<f32>> {
        // 使用统一的 token 限制配置
        let tokens = self.tokenizer.encode_with_special_tokens(text);
        let processed_text = if tokens.len() > MAX_CHUNK_TOKENS {
            log::warn!(
                "文本过长 ({} tokens)，按 token 截断到 {} tokens",
                tokens.len(),
                MAX_CHUNK_TOKENS
            );
            let preview = text.chars().take(120).collect::<String>();
            log::debug!("原文本预览(120)：{}", preview);
            let clipped = &tokens[..MAX_CHUNK_TOKENS];
            // 将截断后的 token 反解码为字符串
            self.tokenizer.decode(clipped.to_vec())
                .unwrap_or_else(|_| text.chars().take(1000).collect::<String>())
        } else {
            text.to_string()
        };

        const MAX_RETRIES: u32 = 3;
        let mut attempt: u32 = 0;
        // 实际发送的 token 数（截断后）：嵌入用量的记账口径（本地 tokenizer 计数，
        // 免解析各家响应的 usage 字段——Ollama 本地与 OpenAI 兼容端点通吃）
        let sent_tokens = tokens.len().min(MAX_CHUNK_TOKENS) as i64;
        loop {
            match self.embed_once(&processed_text).await {
                Ok(embedding) => {
                    // 首次调用时检测并缓存维度（并发下多任务同值 set-once，竞写无害）
                    if self.embedding_dimension.get().is_none() {
                        let detected_dimension = embedding.len();
                        log::info!("检测到向量维度: {}", detected_dimension);
                        let _ = self.embedding_dimension.set(detected_dimension);
                    }
                    self.record_embed_usage(sent_tokens);
                    return Ok(embedding);
                }
                Err(e) => {
                    attempt += 1;
                    if attempt > MAX_RETRIES {
                        return Err(e);
                    }
                    let backoff = std::time::Duration::from_millis(500u64 << (attempt - 1));
                    log::warn!(
                        "embed 请求失败，第 {}/{} 次重试（{:?} 后）: {}",
                        attempt, MAX_RETRIES, backoff, e
                    );
                    tokio::time::sleep(backoff).await;
                }
            }
        }
    }

    /// 单次 embed HTTP 调用（重试时重建请求；429/超时/网络错误同等对待，由调用方退避）
    async fn embed_once(&self, processed_text: &str) -> Result<Vec<f32>> {
        // 判断是否为 Ollama API（根据 URL 结尾）
        let is_ollama = self.embeddings_url.ends_with("/api/embed");

        let mut req = self.client
            .post(&self.embeddings_url)
            .header("Content-Type", "application/json");

        if is_ollama {
            // Ollama 格式：input 是字符串
            let request = OllamaEmbeddingRequest {
                model: self.model_name.clone(),
                input: processed_text.to_string(),
            };
            req = req.json(&request);
        } else {
            // OpenAI 格式：input 是数组
            let request = OpenAIEmbeddingRequest {
                input: vec![processed_text.to_string()],
                model: self.model_name.clone(),
                encoding_format: "float".to_string(),
            };
            req = req.json(&request);
        }

        if let Some(k) = &self.api_key {
            req = req.header("Authorization", format!("Bearer {}", k));
        }

        let response = req
            .send()
            .await
            .context("Failed to send request to embedding API")?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            anyhow::bail!("Embedding API error ({}): {}", status, error_text);
        }

        let embedding = if is_ollama {
            // 解析 Ollama 响应
            let embedding_response: OllamaEmbeddingResponse = response
                .json()
                .await
                .context("Failed to parse Ollama embedding API response")?;

            if embedding_response.embeddings.is_empty() {
                anyhow::bail!("No embeddings returned from Ollama API");
            }

            embedding_response.embeddings[0].clone()
        } else {
            // 解析 OpenAI 响应
            let embedding_response: OpenAIEmbeddingResponse = response
                .json()
                .await
                .context("Failed to parse OpenAI embedding API response")?;

            if embedding_response.data.is_empty() {
                anyhow::bail!("No embeddings returned from OpenAI API");
            }

            embedding_response.data[0].embedding.clone()
        };

        Ok(embedding)
    }



    /// 检测向量维度（通过发送测试文本）
    pub async fn detect_embedding_dimension(&self) -> Result<usize> {
        if let Some(dimension) = self.embedding_dimension.get() {
            return Ok(*dimension);
        }

        // 发送测试文本来检测维度
        let test_embedding = self.vectorize_text("test").await?;
        Ok(test_embedding.len())
    }

    /// 嵌入用量落账（best-effort）：一行 ai_usage（kind='embed'，scope 同值；output 恒 0）。
    /// provider_id 取 embeddings_url 的 host（区分 dashscope/openai/本地等端点）。
    /// 打不开库/表不存在/锁忙一律只记日志——统计绝不能反过来影响向量化
    fn record_embed_usage(&self, sent_tokens: i64) {
        let Some(db_path) = &self.usage_db else { return };
        if sent_tokens <= 0 {
            return;
        }
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let host = host_of(&self.embeddings_url);
        let conn = rusqlite::Connection::open_with_flags(
            db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        );
        let Ok(conn) = conn else {
            log::debug!("[embed-usage] 打开 app.db 失败，跳过记账");
            return;
        };
        let _ = conn.busy_timeout(std::time::Duration::from_millis(500));
        let res = conn.execute(
            "INSERT INTO ai_usage (thread_id, scope, kind, provider_id, model_id, input_tokens, output_tokens, created_at)
             VALUES (NULL, 'embed', 'embed', ?1, ?2, ?3, 0, ?4)",
            rusqlite::params![host, self.model_name, sent_tokens, now_ms],
        );
        if let Err(e) = res {
            log::debug!("[embed-usage] 记账失败（不影响向量化）: {}", e);
        }
    }
}

/// 从 URL 粗取 host（统计分组用，不求精确解析）：https://a.b.com/x → a.b.com
fn host_of(url: &str) -> String {
    let s = url
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    s.split(['/']).next().unwrap_or("").to_string()
}
