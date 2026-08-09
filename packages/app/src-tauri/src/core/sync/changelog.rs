use super::tables::{self, ColType};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::{Row, SqlitePool};
use std::collections::HashMap;

/// changeset 数据行（协议 §5）
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ChangeRow {
    pub table: String,
    pub id: String,
    pub op: String, // INSERT | UPDATE | DELETE
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Serialize)]
struct ChangesetHeader {
    protocol: u32,
    device_id: String,
    seq_from: i64,
    seq_to: i64,
    created_at: i64,
    app_version: String,
}

pub struct PackedChangeset {
    pub seq_to: i64,
    pub jsonl: String,
    pub row_count: usize,
}

struct LogEntry {
    seq: i64,
    table_name: String,
    row_id: String,
    op: String,
    at: i64,
}

/// 把整行读成 JSON（只含注册表里的已知列）
async fn fetch_row_json(pool: &SqlitePool, table: &tables::SyncTable, id: &str) -> Result<Option<Value>, String> {
    let columns = table
        .columns
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("SELECT {columns} FROM {} WHERE {} = ?", table.name, table.pk);
    let row = sqlx::query(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("读取变更行失败: {e}"))?;

    let Some(row) = row else { return Ok(None) };

    let mut map = Map::new();
    for (name, col_type) in table.columns {
        let value = match col_type {
            ColType::Text => match row.try_get::<Option<String>, _>(*name) {
                Ok(v) => v.map(Value::from).unwrap_or(Value::Null),
                Err(_) => Value::Null,
            },
            ColType::Int => match row.try_get::<Option<i64>, _>(*name) {
                Ok(v) => v.map(Value::from).unwrap_or(Value::Null),
                Err(_) => Value::Null,
            },
        };
        map.insert(name.to_string(), value);
    }

    Ok(Some(Value::Object(map)))
}

/// 把 _sync_log 中 seq > last_pushed_seq 的条目打包成 changeset（JSONL）
pub async fn pack_changes(
    pool: &SqlitePool,
    device_id: &str,
    app_version: &str,
    last_pushed_seq: i64,
) -> Result<Option<PackedChangeset>, String> {
    let rows = sqlx::query("SELECT seq, table_name, row_id, op, at FROM _sync_log WHERE seq > ? ORDER BY seq ASC")
        .bind(last_pushed_seq)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("读取变更日志失败: {e}"))?;

    if rows.is_empty() {
        return Ok(None);
    }

    let entries: Vec<LogEntry> = rows
        .iter()
        .map(|row| LogEntry {
            seq: row.get("seq"),
            table_name: row.get("table_name"),
            row_id: row.get("row_id"),
            op: row.get("op"),
            at: row.get("at"),
        })
        .collect();

    let seq_from = entries.first().unwrap().seq;
    let seq_to = entries.last().unwrap().seq;

    // 同一 (table,row_id) 只保留最后一次操作（按 seq 大者），减少冗余传输
    let mut latest: HashMap<(String, String), &LogEntry> = HashMap::new();
    for entry in &entries {
        latest
            .entry((entry.table_name.clone(), entry.row_id.clone()))
            .and_modify(|current| {
                if entry.seq > current.seq {
                    *current = entry;
                }
            })
            .or_insert(entry);
    }

    let mut change_rows: Vec<ChangeRow> = Vec::new();
    for ((table_name, row_id), entry) in &latest {
        let Some(table) = tables::find_table(table_name) else {
            continue; // 未注册的表（不该发生，防御）
        };

        if entry.op == "DELETE" {
            change_rows.push(ChangeRow {
                table: table_name.clone(),
                id: row_id.clone(),
                op: "DELETE".to_string(),
                updated_at: entry.at,
                data: None,
            });
            continue;
        }

        match fetch_row_json(pool, table, row_id).await? {
            Some(data) => {
                let updated_at = data
                    .get("updated_at")
                    .and_then(Value::as_i64)
                    .unwrap_or(entry.at);
                change_rows.push(ChangeRow {
                    table: table_name.clone(),
                    id: row_id.clone(),
                    op: entry.op.clone(),
                    updated_at,
                    data: Some(data),
                });
            }
            None => {
                // 行已被删（INSERT/UPDATE 之后又删了）→ 转成墓碑
                change_rows.push(ChangeRow {
                    table: table_name.clone(),
                    id: row_id.clone(),
                    op: "DELETE".to_string(),
                    updated_at: entry.at,
                    data: None,
                });
            }
        }
    }

    // 稳定输出：按 table+id 排序，幂等可 diff
    change_rows.sort_by(|a, b| (&a.table, &a.id).cmp(&(&b.table, &b.id)));
    let row_count = change_rows.len();

    let header = ChangesetHeader {
        protocol: 1,
        device_id: device_id.to_string(),
        seq_from,
        seq_to,
        created_at: chrono::Utc::now().timestamp_millis(),
        app_version: app_version.to_string(),
    };

    let mut jsonl = serde_json::to_string(&serde_json::json!({ "header": header })).map_err(|e| e.to_string())?;
    let mut skipped_oversize = 0usize;
    for row in &change_rows {
        let line = serde_json::to_string(row).map_err(|e| e.to_string())?;
        // 大行安全阀：单行超限（如几十 MB 的工具密集对话线程）直接跳过并告警，防烧掉坚果云配额
        if line.len() > MAX_ROW_BYTES {
            log::warn!(
                "changeset 跳过超大行 {}:{}（{} bytes，阈值 {}）",
                row.table,
                row.id,
                line.len(),
                MAX_ROW_BYTES
            );
            skipped_oversize += 1;
            continue;
        }
        jsonl.push('\n');
        jsonl.push_str(&line);
    }
    if skipped_oversize > 0 {
        log::warn!("本包跳过 {skipped_oversize} 行超大行（这些行不会同步到其他设备）");
    }

    Ok(Some(PackedChangeset {
        seq_to,
        jsonl,
        row_count: row_count - skipped_oversize,
    }))
}


// ---- changeset 线上编码（gzip）与大行安全阀 ----

/// 单行序列化上限：超过即跳过（防几十 MB 的工具密集对话线程烧掉坚果云配额）
const MAX_ROW_BYTES: usize = 20 * 1024 * 1024;

/// changeset 线上格式 = gzip(JSONL)。结构化 JSON 实测压缩 10 倍+，坚果云流量敏感。
/// 旧版裸 JSONL 存量包由 decode 按魔数嗅探兼容；旧版 app 读不了新 gzip 包（自同步场景两端同版本，可接受）。
pub fn encode_changeset(jsonl: &str) -> Result<Vec<u8>, String> {
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    enc.write_all(jsonl.as_bytes())
        .map_err(|e| format!("changeset 压缩失败: {e}"))?;
    enc.finish().map_err(|e| format!("changeset 压缩失败: {e}"))
}

/// 解码 changeset：gzip 魔数嗅探，非 gzip 按裸 JSONL 原样通过（兼容压缩前的存量包）
pub fn decode_changeset(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.starts_with(&[0x1f, 0x8b]) {
        use flate2::read::GzDecoder;
        use std::io::Read;
        let mut dec = GzDecoder::new(bytes);
        let mut out = Vec::new();
        dec.read_to_end(&mut out)
            .map_err(|e| format!("changeset 解压失败: {e}"))?;
        Ok(out)
    } else {
        Ok(bytes.to_vec())
    }
}

#[cfg(test)]
mod codec_tests {
    use super::*;

    #[test]
    fn test_changeset_codec_roundtrip() {
        // 重复结构负载（真实 changeset 行形态）：gzip 应显著压缩；小负载盖不住 gzip 头开销属正常
        let line = "{\"table\":\"threads\",\"id\":\"t1\",\"op\":\"UPDATE\",\"updated_at\":1,\"data\":{\"messages\":\"[{\\\"id\\\":\\\"m1\\\"}]\"}}\n";
        let jsonl = format!("{{\"header\":{{}}}}\n{}", line.repeat(200));
        let encoded = encode_changeset(&jsonl).unwrap();
        assert!(encoded.starts_with(&[0x1f, 0x8b]));
        assert!(encoded.len() < jsonl.len() / 5, "结构化 JSON 应至少压缩 5 倍");
        let decoded = decode_changeset(&encoded).unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), jsonl);
    }

    #[test]
    fn test_decode_raw_passthrough() {
        // 压缩前的裸 JSONL 存量包：原样通过
        let raw = b"{\"header\":{}}\n{\"table\":\"tags\"}";
        let decoded = decode_changeset(raw).unwrap();
        assert_eq!(decoded, raw);
    }
}
