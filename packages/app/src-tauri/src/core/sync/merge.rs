use serde_json::Value;

/// threads 整行数据（消息字段是 JSON 字符串）
#[derive(Debug, Clone, PartialEq)]
pub struct ThreadRowData {
    pub id: String,
    pub book_id: Option<String>,
    pub metadata: String,
    pub title: String,
    pub messages: String,
    pub starred: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 通用 LWW 判断：remote 是否赢（本地不存在必赢，严格大于才赢——保证重放幂等）
pub fn remote_wins(local_updated_at: Option<i64>, remote_updated_at: i64) -> bool {
    match local_updated_at {
        None => true,
        Some(local) => remote_updated_at > local,
    }
}

fn parse_messages(json: &str) -> Vec<Value> {
    serde_json::from_str(json).unwrap_or_default()
}

/// 同 id 冲突时的新旧判断键：metadata.updatedAt 优先，其次 createdAt
fn message_updated_at(msg: &Value) -> i64 {
    msg.pointer("/metadata/updatedAt")
        .and_then(Value::as_i64)
        .or_else(|| msg.pointer("/metadata/createdAt").and_then(Value::as_i64))
        .unwrap_or(0)
}

/// 消息级并集合并（协议 §6）：
/// 两边 messages 按消息 id 取并集；顺序用“位置锚点归并”——
/// 两端共有的消息作为锚点（按本地位置排），各端独有的消息按“位于哪两个锚点之间”插入对应位置。
/// 不依赖 metadata.createdAt（用户消息创建时无 metadata，且精度只有秒级，均会导致排序失败）。
pub fn merge_thread_messages(local_json: &str, remote_json: &str) -> Vec<Value> {
    let local = parse_messages(local_json);
    let remote = parse_messages(remote_json);

    let local_ids: Vec<Option<String>> = local.iter().map(|m| msg_id(m)).collect();
    let remote_ids: Vec<Option<String>> = remote.iter().map(|m| msg_id(m)).collect();

    // id -> 两端数组中的位置
    let mut local_pos: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    let mut remote_pos: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for (i, id) in local_ids.iter().enumerate() {
        if let Some(id) = id {
            local_pos.entry(id.as_str()).or_insert(i);
        }
    }
    for (i, id) in remote_ids.iter().enumerate() {
        if let Some(id) = id {
            remote_pos.entry(id.as_str()).or_insert(i);
        }
    }

    // 锚点：两端共有的消息，按本地位置排序（本地顺序作为展示基准）
    let mut anchors: Vec<(usize, usize, String)> = local_pos
        .iter()
        .filter(|(id, _)| remote_pos.contains_key(**id))
        .map(|(id, &lp)| (lp, remote_pos[*id], id.to_string()))
        .collect();
    anchors.sort_by_key(|&(lp, _, _)| lp);

    // 每条消息的排序键 (slot, offset)：
    // 锚点 k 的 slot = 2k+1（奇数）；锚点 k 与 k+1 之间的消息 slot = 2k+2（偶数）；
    // 第一个锚点之前的消息 slot = 0。这样保证：前组 < 锚点 < 后组，严格交错。
    let mut sort_keys: std::collections::HashMap<String, (usize, f64)> = std::collections::HashMap::new();

    for (is_remote, ids) in [(false, &local_ids), (true, &remote_ids)] {
        // 按“前方锚点数”分组，统计组内独有消息数量（用于均匀分布 offset）
        let mut group_counts: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
        for (i, id) in ids.iter().enumerate() {
            let is_anchor = id.as_ref().is_some_and(|id| local_pos.contains_key(id.as_str()) && remote_pos.contains_key(id.as_str()));
            if is_anchor {
                continue;
            }
            let group = group_index_for(ids, i, &anchors, is_remote);
            *group_counts.entry(group).or_insert(0) += 1;
        }

        let mut group_seen: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
        for (i, id) in ids.iter().enumerate() {
            let key = match id {
                Some(id) if local_pos.contains_key(id.as_str()) && remote_pos.contains_key(id.as_str()) => {
                    // 锚点消息：slot = 2*anchor_idx + 1，保证前后组消息严格分居两侧
                    let anchor_idx = anchors.iter().position(|a| a.2 == *id).unwrap_or(0);
                    (2 * anchor_idx + 1, 0.0)
                }
                _ => {
                    // 独有消息（含无 id 的）：slot = 2*group（偶数），组内均匀分布
                    let group = group_index_for(ids, i, &anchors, is_remote);
                    let total = group_counts.get(&group).copied().unwrap_or(1);
                    let seen = group_seen.entry(group).or_insert(0);
                    *seen += 1;
                    // 组内 local 占前半区、remote 占后半区（无时间信息时的确定性约定）
                    let base = if is_remote { 0.5 } else { 0.0 };
                    (2 * group, base + (*seen as f64) / ((total + 1) as f64) * 0.5)
                }
            };
            // 无 id 消息给合成键，保证不撞
            let map_key = id.clone().unwrap_or_else(|| format!("__noid_{}_{}", if is_remote { "r" } else { "l" }, i));
            sort_keys.entry(map_key).or_insert(key);
        }
    }

    // 并集：同 id 按 metadata.updatedAt 取新（相等保本地，确定性）
    let mut by_id: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    let mut all_keys: Vec<String> = Vec::new();
    for (is_remote, msg) in local.into_iter().map(|m| (false, m)).chain(remote.into_iter().map(|m| (true, m))) {
        let id = msg_id(&msg).unwrap_or_else(|| format!("__noid_{}_{}", if is_remote { "r" } else { "l" }, by_id.len()));
        match by_id.get(&id) {
            None => {
                all_keys.push(id.clone());
                by_id.insert(id, msg);
            }
            Some(existing) => {
                if message_updated_at(&msg) > message_updated_at(existing) {
                    by_id.insert(id, msg);
                }
            }
        }
    }

    let mut merged: Vec<((usize, f64), Value)> = all_keys
        .into_iter()
        .filter_map(|id| by_id.remove(&id).map(|msg| (id, msg)))
        .map(|(id, msg)| {
            let key = sort_keys.get(&id).copied().unwrap_or((usize::MAX, 0.0));
            (key, msg)
        })
        .collect();

    merged.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    merged.into_iter().map(|(_, msg)| msg).collect()
}

fn msg_id(msg: &Value) -> Option<String> {
    msg.get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(|id| id.to_string())
}

/// 位置 i 的消息属于哪个锚点组（= 其前方最近锚点的序号，无前方锚点则为 0）
fn group_index_for(
    ids: &[Option<String>],
    i: usize,
    anchors: &[(usize, usize, String)],
    is_remote: bool,
) -> usize {
    // 在该端数组中，位置 i 之前最近的锚点
    let mut group = 0;
    for (idx, anchor) in anchors.iter().enumerate() {
        let pos_in_this_side = if is_remote { anchor.1 } else { anchor.0 };
        if pos_in_this_side < i {
            group = idx + 1;
        } else {
            break;
        }
    }
    let _ = ids; // 保留参数签名对称性
    group
}

/// threads 行级合并：messages 永远并集合并，其余字段整行 LWW
pub fn merge_thread_row(local: Option<&ThreadRowData>, remote: &ThreadRowData) -> ThreadRowData {
    match local {
        None => remote.clone(),
        Some(local) => {
            let merged_messages = merge_thread_messages(&local.messages, &remote.messages);
            let messages = serde_json::to_string(&merged_messages).unwrap_or_else(|_| "[]".to_string());
            if remote_wins(Some(local.updated_at), remote.updated_at) {
                ThreadRowData {
                    messages,
                    ..remote.clone()
                }
            } else {
                ThreadRowData {
                    messages,
                    ..local.clone()
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(id: &str, created_at: i64, updated_at: i64) -> Value {
        serde_json::json!({
            "id": id,
            "role": "user",
            "parts": [],
            "metadata": { "createdAt": created_at, "updatedAt": updated_at }
        })
    }

    fn msgs_json(msgs: &[Value]) -> String {
        serde_json::to_string(&serde_json::json!(msgs)).unwrap()
    }

    fn ids(msgs: &[Value]) -> Vec<String> {
        msgs.iter().map(|m| m["id"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn test_merge_union_and_sort() {
        // 并集：两边不同 id 的消息都保留
        // 两端无共同消息（无锚点）时无法判断交错顺序，约定 local 在前、remote 在后（确定性）
        let local = msgs_json(&[msg("a", 100, 100), msg("c", 300, 300)]);
        let remote = msgs_json(&[msg("b", 200, 200), msg("d", 400, 400)]);
        let merged = merge_thread_messages(&local, &remote);
        assert_eq!(ids(&merged), vec!["a", "c", "b", "d"]);
    }

    #[test]
    fn test_merge_interleaved_sort() {
        // 分叉场景：本地先有 a,c；远端后有 b（时间更晚）→ 并集后按位置归并
        let local = msgs_json(&[msg("a", 100, 100), msg("c", 200, 200)]);
        let remote = msgs_json(&[msg("a", 100, 100), msg("b", 300, 300)]);
        let merged = merge_thread_messages(&local, &remote);
        assert_eq!(ids(&merged), vec!["a", "c", "b"]);
    }

    #[test]
    fn test_merge_diverged_qa_interleaves_by_position() {
        // 用户场景复现：共享基础对话 base，A 端追加 q1+a1，B 端追加 q2+a2
        // 旧算法按 metadata 时间戳排序（用户消息无 metadata → 0）→ 问全在前答全在后
        // 新算法按锚点位置归并 → 各端 Q&A 保持相邻，正确交错
        let local = msgs_json(&[
            msg("base", 100, 100),
            msg("q1", 200, 200),
            msg("a1", 210, 210),
        ]);
        let remote = msgs_json(&[
            msg("base", 100, 100),
            msg("q2", 220, 220),
            msg("a2", 230, 230),
        ]);
        let merged = merge_thread_messages(&local, &remote);
        // base 是锚点；q1,a1 是 local 独有（锚点后）；q2,a2 是 remote 独有（锚点后）
        // 同组内 local 在前：base, q1, a1, q2, a2
        assert_eq!(ids(&merged), vec!["base", "q1", "a1", "q2", "a2"]);

        // 反向合并（幂等性）：结果应一致（local/remote 对调后 local 在前约定仍确定性）
        let merged2 = merge_thread_messages(&remote, &local);
        assert_eq!(ids(&merged2), vec!["base", "q2", "a2", "q1", "a1"]);
    }

    #[test]
    fn test_merge_multi_anchor_gaps() {
        // 多锚点：两端在相同锚点之间各自插入消息，应插入对应间隙而非尾部
        let local = msgs_json(&[
            msg("a1", 100, 100),
            msg("x", 150, 150),   // local 独有，在 a1 和 a2 之间
            msg("a2", 200, 200),
        ]);
        let remote = msgs_json(&[
            msg("a1", 100, 100),
            msg("y", 160, 160),   // remote 独有，在 a1 和 a2 之间
            msg("a2", 200, 200),
        ]);
        let merged = merge_thread_messages(&local, &remote);
        // a1, a2 是锚点；x 和 y 都在同一间隙（a1 之后 a2 之前），local 在前
        assert_eq!(ids(&merged), vec!["a1", "x", "y", "a2"]);
    }

    #[test]
    fn test_merge_same_id_newer_wins() {
        // 同 id：remote 更新（updatedAt 更大）则取 remote 内容
        let mut older = msg("a", 100, 100);
        older["parts"] = serde_json::json!([{"type": "text", "text": "旧"}]);
        let mut newer = msg("a", 100, 200);
        newer["parts"] = serde_json::json!([{"type": "text", "text": "新"}]);
        let merged = merge_thread_messages(&msgs_json(&[older]), &msgs_json(&[newer]));
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0]["parts"][0]["text"].as_str().unwrap(), "新");

        // 反过来 remote 更旧：保本地
        let mut older2 = msg("a", 100, 100);
        older2["parts"] = serde_json::json!([{"type": "text", "text": "旧"}]);
        let mut newer2 = msg("a", 100, 200);
        newer2["parts"] = serde_json::json!([{"type": "text", "text": "新"}]);
        let merged2 = merge_thread_messages(&msgs_json(&[newer2]), &msgs_json(&[older2]));
        assert_eq!(merged2[0]["parts"][0]["text"].as_str().unwrap(), "新");
    }

    #[test]
    fn test_merge_empty_sides() {
        // 空边：local 空 / remote 空 / 两边都空
        let remote = msgs_json(&[msg("a", 100, 100)]);
        assert_eq!(ids(&merge_thread_messages("[]", &remote)), vec!["a"]);
        assert_eq!(ids(&merge_thread_messages(&remote, "[]")), vec!["a"]);
        assert!(merge_thread_messages("[]", "[]").is_empty());
        // 非法 JSON 也不炸
        assert!(merge_thread_messages("not-json", "[]").is_empty());
    }

    #[test]
    fn test_remote_wins() {
        assert!(remote_wins(None, 100));
        assert!(remote_wins(Some(99), 100));
        assert!(!remote_wins(Some(100), 100)); // 相等不赢 → 重放幂等
        assert!(!remote_wins(Some(101), 100));
    }

    #[test]
    fn test_merge_thread_row_fields() {
        // 行级：messages 并集；title 等字段 LWW
        let local = ThreadRowData {
            id: "t".into(),
            book_id: None,
            metadata: "{}".into(),
            title: "旧标题".into(),
            messages: msgs_json(&[msg("a", 100, 100)]),
            starred: 0,
            created_at: 100,
            updated_at: 200,
        };
        let remote = ThreadRowData {
            title: "新标题".into(),
            messages: msgs_json(&[msg("b", 300, 300)]),
            updated_at: 300,
            ..local.clone()
        };
        let merged = merge_thread_row(Some(&local), &remote);
        assert_eq!(merged.title, "新标题"); // remote 更新，字段取 remote
        assert_eq!(ids(&parse_messages(&merged.messages)), vec!["a", "b"]); // 消息并集

        // local 更新：字段保 local，消息仍并集
        let remote_older = ThreadRowData {
            title: "更旧标题".into(),
            messages: msgs_json(&[msg("b", 300, 300)]),
            updated_at: 100,
            ..local.clone()
        };
        let merged2 = merge_thread_row(Some(&local), &remote_older);
        assert_eq!(merged2.title, "旧标题");
        assert_eq!(ids(&parse_messages(&merged2.messages)), vec!["a", "b"]);
    }
}
