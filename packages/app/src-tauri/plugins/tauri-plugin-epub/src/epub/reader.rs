use anyhow::{Context, Result};
use epub::doc::EpubDoc;
use std::path::Path;

use crate::models::{EpubChapter, EpubContent};
use crate::text::{TextChunker, TextSanitizer};

pub struct EpubReader {
    chunker: TextChunker,
}

impl EpubReader {
    pub fn new() -> Result<Self> {
        let chunker = TextChunker::new().context("Failed to initialize text chunker")?;

        Ok(Self {
            chunker,
        })
    }

    /// 读取 EPUB 文件并提取所有文本内容
    pub fn read_epub<P: AsRef<Path>>(&self, path: P) -> Result<EpubContent> {
        let mut doc = EpubDoc::new(path).context("Failed to open EPUB file")?;

        // 获取书籍基本信息
        let title = doc
            .mdata("title")
            .unwrap_or_else(|| "Unknown Title".to_string());
        let author = doc
            .mdata("creator")
            .or_else(|| doc.mdata("author"))
            .unwrap_or_else(|| "Unknown Author".to_string());

        log::info!("Reading EPUB: {} by {}", title, author);
        log::info!("EPUB spine length: {}", doc.spine.len());
        log::info!("EPUB resources count: {}", doc.resources.len());

        let mut chapters = Vec::new();
        let spine_len = doc.get_num_pages();

        for i in 0..spine_len {
            doc.set_current_page(i);

            // 获取当前页面的HTML内容（get_current_str 返回 (内容, MIME)，取第一个元素；E3 修复）
            let html_content = doc.get_current_str().unwrap_or_default();
            let html_str = &html_content.0;

            // 提取章节标题
            let chapter_title = self
                .extract_chapter_title(html_str)
                .unwrap_or_else(|| format!("Chapter {}", i + 1));

            // 提取并清理文本内容
            let content = self.extract_text_content(html_str).unwrap_or_default();

            if !content.trim().is_empty() {
                chapters.push(EpubChapter {
                    title: chapter_title,
                    content,
                    order: i,
                });
            }
        }

        log::info!("Extracted {} chapters", chapters.len());

        Ok(EpubContent {
            title,
            author,
            chapters,
        })
    }

    /// 从HTML内容中提取纯文本
    fn extract_text_content(&self, html: &str) -> Result<String> {
        let mut text = html.to_string();

        // 首先移除脚本和样式标签（包括其内容）
        let script_style_patterns = [
            r"(?is)<script[^>]*>.*?</script>",
            r"(?is)<style[^>]*>.*?</style>",
            r"(?is)<!--.*?-->", // 移除HTML注释
        ];

        for pattern in &script_style_patterns {
            let re = regex::Regex::new(pattern)?;
            text = re.replace_all(&text, " ").to_string();
        }

        // 处理块级元素，在它们周围添加换行
        let block_elements = [
            r"(?i)</?(div|p|h[1-6]|section|article|chapter|br)[^>]*>",
            r"(?i)</?(ul|ol|li|dl|dt|dd)[^>]*>",
            r"(?i)</?(table|tr|td|th)[^>]*>",
            r"(?i)</?(header|footer|nav|main|aside)[^>]*>",
        ];

        for pattern in &block_elements {
            let re = regex::Regex::new(pattern)?;
            text = re.replace_all(&text, "\n").to_string();
        }

        // 移除所有剩余的HTML标签
        let re = regex::Regex::new(r"<[^>]+>")?;
        text = re.replace_all(&text, " ").to_string();

        // 解码HTML实体
        text = TextSanitizer::decode_html_entities(&text);

        // 清理空白字符
        text = TextSanitizer::normalize_whitespace(&text);

        Ok(text)
    }

    /// 提取章节标题
    fn extract_chapter_title(&self, html: &str) -> Option<String> {
        // 尝试从标题标签中提取标题，按优先级排序
        let title_patterns = [
            r"(?is)<title[^>]*>(.*?)</title>",
            r"(?is)<h1[^>]*>(.*?)</h1>",
            r"(?is)<h2[^>]*>(.*?)</h2>",
            r"(?is)<h3[^>]*>(.*?)</h3>",
            r"(?is)<h4[^>]*>(.*?)</h4>",
            // 查找带有特定class的元素
            r#"(?is)<[^>]*class=\"[^\"]*title[^\"]*\"[^>]*>(.*?)</[^>]*>"#,
            r#"(?is)<[^>]*class=\"[^\"]*chapter[^\"]*\"[^>]*>(.*?)</[^>]*>"#,
        ];

        for pattern in &title_patterns {
            if let Ok(re) = regex::Regex::new(pattern) {
                if let Some(captures) = re.captures(html) {
                    if let Some(title_match) = captures.get(1) {
                        let title = title_match.as_str();
                        let clean_title = TextSanitizer::clean_html_content(title);
                        let clean_title = clean_title.trim();

                        // 过滤掉太短或太长的标题
                        if !clean_title.is_empty()
                            && clean_title.len() >= 1
                            && clean_title.len() <= 200
                        {
                            // 清理常见的无用标题
                            if !clean_title.to_lowercase().contains("untitled")
                                && !clean_title.to_lowercase().contains("unnamed")
                                && !clean_title
                                    .chars()
                                    .all(|c| c.is_numeric() || c.is_whitespace())
                            {
                                return Some(clean_title.to_string());
                            }
                        }
                    }
                }
            }
        }

        None
    }

    /// 专门用于 Markdown 文件的智能分块方法
    /// 考虑 Markdown 格式特性：标题层级、段落边界、代码块等
    pub fn chunk_md_file(&self, md_content: &str, min_tokens: usize, max_tokens: usize) -> Vec<String> {
        self.chunker.chunk_md_file(md_content, min_tokens, max_tokens)
    }

    /// 带「参考文献区段」标记的 Markdown 分块（透传 TextChunker）：
    /// 返回 (分片文本, 是否参考文献区段)，建索引时用于给参考文献分片打标
    pub fn chunk_md_file_flagged(&self, md_content: &str, min_tokens: usize, max_tokens: usize) -> Vec<(String, bool)> {
        self.chunker.chunk_md_file_flagged(md_content, min_tokens, max_tokens)
    }

    pub fn search_text<P: AsRef<Path>>(
        &self,
        path: P,
        query: &str,
        limit: usize,
        max_sections: Option<usize>,
        max_duration_ms: Option<u64>,
        include_references: bool,
    ) -> Result<EpubTextSearchResult, String> {
        self.search_text_with_extractor(path, query, limit, max_sections, max_duration_ms, include_references, |html| {
            self.extract_text_content(html)
        })
    }

    fn search_text_with_extractor<P, F>(
        &self,
        path: P,
        query: &str,
        limit: usize,
        max_sections: Option<usize>,
        max_duration_ms: Option<u64>,
        include_references: bool,
        mut extractor: F,
    ) -> Result<EpubTextSearchResult, String>
    where
        P: AsRef<Path>,
        F: FnMut(&str) -> Result<String>,
    {
        fn find_case_insensitive(text: &str, query: &str) -> Option<(usize, usize)> {
            if query.is_empty() {
                return None;
            }
            let mut folded = String::new();
            let mut original_indices = Vec::new();
            for (index, ch) in text.char_indices() {
                for lower in ch.to_lowercase() {
                    folded.push(lower);
                    original_indices.push(index);
                }
            }
            let folded_query = query.to_lowercase();
            let matched = folded.find(&folded_query)?;
            let char_index = folded[..matched].chars().count();
            let query_chars = folded_query.chars().count();
            let start = *original_indices.get(char_index)?;
            let last = *original_indices.get(char_index + query_chars.checked_sub(1)?)?;
            let end = last + text[last..].chars().next()?.len_utf8();
            Some((start, end))
        }

        fn byte_at_char(text: &str, index: usize) -> usize {
            text.char_indices().nth(index).map(|(at, _)| at).unwrap_or(text.len())
        }

        fn snippet(text: &str, terms: &[&str]) -> String {
            let first = terms
                .iter()
                .filter_map(|term| find_case_insensitive(text, term))
                .min_by_key(|(start, _)| *start);
            let Some((match_start, _)) = first else {
                return text.chars().take(400).collect();
            };
            let char_at = text[..match_start].chars().count();
            let start_char = char_at.saturating_sub(160);
            let end_char = (char_at + 240).min(text.chars().count());
            let mut out = text[byte_at_char(text, start_char)..byte_at_char(text, end_char)]
                .trim()
                .to_string();
            if end_char < text.chars().count() {
                out.push('…');
            }
            out
        }

        fn matches(text: &str, terms: &[&str]) -> bool {
            terms.iter().all(|term| find_case_insensitive(text, term).is_some())
        }

        fn references_heading(heading: &str) -> bool {
            let normalized = heading.trim().to_lowercase();
            normalized.starts_with("references")
                || normalized.starts_with("bibliography")
                || normalized.contains("参考文献")
        }

        let query = query.trim();
        if query.is_empty() {
            return Err("query is empty".into());
        }
        let terms: Vec<&str> = query.split_whitespace().collect();
        let limit = limit.clamp(1, 30);
        let started = std::time::Instant::now();
        let max_duration = max_duration_ms.map(std::time::Duration::from_millis);
        let mut doc = EpubDoc::new(path.as_ref()).map_err(|e| format!("打开 EPUB 失败: {}", e))?;
        let num_pages = doc.get_num_pages();
        let section_cap = max_sections.map(|value| value.clamp(1, 200).min(num_pages)).unwrap_or(num_pages);
        let mut results = Vec::new();
        let mut scanned_sections = 0usize;
        let mut scan_failed = false;

        for spine in 0..num_pages {
            if scanned_sections >= section_cap
                || max_duration.is_some_and(|duration| started.elapsed() >= duration)
                || results.len() >= limit
            {
                break;
            }
            scanned_sections += 1;
            if !doc.set_current_page(spine) {
                scan_failed = true;
                continue;
            }
            let Some((html, _mime)) = doc.get_current_str() else {
                scan_failed = true;
                continue;
            };
            let heading = self.extract_chapter_title(&html).unwrap_or_else(|| format!("Chapter {}", spine + 1));
            let text = match extractor(&html) {
                Ok(text) => text,
                Err(error) => {
                    scan_failed = true;
                    log::warn!("EPUB spine {} 正文提取失败: {}", spine, error);
                    String::new()
                }
            };
            if !include_references && references_heading(&heading) {
                continue;
            }
            let heading_match = matches(&heading, &terms);
            let body_match = matches(&text, &terms);
            if !heading_match && !body_match {
                continue;
            }
            let snippet = if heading_match { snippet(&heading, &terms) } else { snippet(&text, &terms) };
            results.push(EpubTextSearchHit {
                heading,
                spine,
                snippet,
                match_kind: if heading_match { "title" } else { "keyword" }.to_string(),
            });
        }

        Ok(EpubTextSearchResult {
            results,
            scanned_sections,
            partial: scan_failed || scanned_sections < num_pages,
        })
    }

    /// 按章节标题直读小节原文（未向量化兜底通道，不依赖索引/mdbook 产物）。
    /// 定位链：EPUB NCX/Nav 目录 → 扁平化带层级 → 标题匹配（规范化全等 → 包含）→
    /// 条目 href 映射 spine 页 → 小节 = [本条目页, 下一个同级或更高级条目页)；
    /// 目录缺失时退化为逐页标题匹配。文本截断到 max_chars。
    pub fn read_section<P: AsRef<Path>>(
        &self,
        path: P,
        chapter_title: &str,
        max_chars: usize,
    ) -> Result<SectionReadResult, String> {
        struct FlatEntry {
            title: String,
            norm_title: String,
            page_path: Option<String>,
            page_index: Option<usize>,
            depth: usize,
        }

        fn norm_title(s: &str) -> String {
            s.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_lowercase()
        }
        fn norm_path(p: &str) -> String {
            let no_anchor = p.split('#').next().unwrap_or(p);
            no_anchor.replace('\\', "/").trim_start_matches("./").to_string()
        }

        let mut doc = EpubDoc::new(path.as_ref()).map_err(|e| format!("打开 EPUB 失败: {}", e))?;
        let num_pages = doc.get_num_pages();

        // 1. 扁平化目录（带层级与页路径）。多源：
        //    a. doc.toc（epub crate 填充的 NCX 目录；OPF 在子目录或命名空间异常时会空）
        //    b. 自解析 OPF → spine toc 属性 → NCX（插件 toc_parser，对命名空间鲁棒）
        //    c. EPUB3：manifest properties="nav" → nav.xhtml 状态机解析
        fn flatten(nodes: &[epub::doc::NavPoint], depth: usize, out: &mut Vec<(String, String, usize)>) {
            for n in nodes {
                out.push((n.label.clone(), n.content.to_string_lossy().to_string(), depth));
                flatten(&n.children, depth + 1, out);
            }
        }
        let mut flat: Vec<(String, String, usize)> = Vec::new();
        flatten(&doc.toc, 0, &mut flat);
        if flat.is_empty() {
            flat = read_ncx_entries(&mut doc);
        }
        if flat.is_empty() {
            flat = read_nav_entries(&mut doc);
        }

        // 2. 建立 页路径→spine 索引 映射
        let mut page_paths: Vec<String> = Vec::with_capacity(num_pages);
        for i in 0..num_pages {
            let _ = doc.set_current_page(i);
            let p = doc
                .get_current_path()
                .map(|pb| norm_path(&pb.to_string_lossy()))
                .unwrap_or_default();
            page_paths.push(p);
        }
        let page_of = |entry_path: &str| -> Option<usize> {
            let ep = norm_path(entry_path);
            if ep.is_empty() {
                return None;
            }
            page_paths
                .iter()
                .position(|pp| pp == &ep || pp.ends_with(&format!("/{}", ep)) || ep.ends_with(&format!("/{}", pp)))
        };

        let mut entries: Vec<FlatEntry> = flat
            .iter()
            .map(|(t, p, d)| FlatEntry {
                title: t.clone(),
                norm_title: norm_title(t),
                page_index: page_of(p),
                page_path: if p.is_empty() { None } else { Some(p.clone()) },
                depth: *d,
            })
            .collect();

        // 3. 目录为空（或全部映射失败）时退化：逐页标题作为候选
        if entries.iter().all(|e| e.page_index.is_none()) {
            entries.clear();
            for i in 0..num_pages {
                let _ = doc.set_current_page(i);
                // get_current_str 返回 (内容, MIME)：取第一个元素
                if let Some((html, _mime)) = doc.get_current_str() {
                    if let Some(t) = self.extract_chapter_title(&html) {
                        entries.push(FlatEntry {
                            norm_title: norm_title(&t),
                            title: t,
                            page_path: None,
                            page_index: Some(i),
                            depth: 0,
                        });
                    }
                }
            }
        }

        if entries.is_empty() {
            return Err("本书没有可用目录/章节标题，无法按标题定位".to_string());
        }

        // 4. 标题匹配：规范化全等 → 包含 → 被包含。收集全部候选而非首个——
        //    转换器产出的 NCX 可能有同名占位页（divider stub）与正文章节并存，需逐个评估取内容最多者。
        let query = norm_title(chapter_title);
        let collect = |pred: &dyn Fn(&FlatEntry) -> bool| -> Vec<usize> {
            entries.iter().enumerate().filter_map(|(i, e)| if pred(e) { Some(i) } else { None }).collect()
        };
        let mut candidates = collect(&|e| e.norm_title == query);
        if candidates.is_empty() {
            candidates = collect(&|e| e.norm_title.contains(&query));
        }
        if candidates.is_empty() {
            candidates = collect(&|e| query.contains(&e.norm_title));
        }
        if candidates.is_empty() {
            let available = entries
                .iter()
                .take(20)
                .map(|e| e.title.clone())
                .collect::<Vec<_>>()
                .join("；");
            return Err(format!(
                "未找到章节「{}」。可选章节（前 20 条）：{}",
                chapter_title, available
            ));
        }

        // 5. 逐候选计算页范围并提取文本，取内容最多者（评估上限 3 个，防占位页误选）
        let range_of = |idx: usize| -> Option<(usize, usize)> {
            let start = entries[idx].page_index?;
            let target_depth = entries[idx].depth;
            let mut end = num_pages;
            for e in entries.iter().skip(idx + 1) {
                if e.depth <= target_depth {
                    if let Some(p) = e.page_index {
                        if p > start {
                            end = p;
                            break;
                        }
                    }
                }
            }
            if end <= start {
                end = (start + 1).min(num_pages);
            }
            Some((start, end))
        };
        let mut extract = |start: usize, end: usize, doc: &mut EpubDoc<std::io::BufReader<std::fs::File>>| -> String {
            let mut text = String::new();
            for i in start..end {
                let _ = doc.set_current_page(i);
                // get_current_str 返回 (内容, MIME)：取第一个元素
                if let Some((html, _mime)) = doc.get_current_str() {
                    if let Ok(t) = self.extract_text_content(&html) {
                        let t = t.trim();
                        if !t.is_empty() {
                            if !text.is_empty() {
                                text.push_str("\n\n");
                            }
                            text.push_str(t);
                        }
                    }
                }
            }
            text
        };

        let mut best: Option<(usize, String, usize, usize)> = None; // (idx, text, total_chars, pages)
        for &ci in candidates.iter().take(3) {
            let Some((start, end)) = range_of(ci) else { continue };
            let text = extract(start, end, &mut doc);
            let total = text.chars().count();
            if best.as_ref().is_none_or(|b| total > b.2) {
                best = Some((ci, text, total, end - start));
            }
        }

        let (idx, mut text, total_chars, pages) = match best {
            Some(b) => b,
            None => return Err(format!("章节「{}」无法映射到正文页", chapter_title)),
        };

        // 6. 截断
        let truncated = total_chars > max_chars;
        if truncated {
            text = text.chars().take(max_chars).collect();
        }

        Ok(SectionReadResult {
            matched_title: entries[idx].title.clone(),
            text,
            truncated,
            total_chars,
            pages,
        })
    }
}

#[derive(Debug, serde::Serialize)]
pub struct EpubTextSearchHit {
    pub heading: String,
    pub spine: usize,
    pub snippet: String,
    pub match_kind: String,
}

#[derive(Debug, serde::Serialize)]
pub struct EpubTextSearchResult {
    pub results: Vec<EpubTextSearchHit>,
    pub scanned_sections: usize,
    pub partial: bool,
}

/// read_section 的返回（camelCase 序列化给前端）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionReadResult {
    pub matched_title: String,
    pub text: String,
    pub truncated: bool,
    pub total_chars: usize,
    pub pages: usize,
}

/// 自解析 OPF → spine toc 属性 → NCX 目录（doc.toc 为空时的兜底；
/// 插件 toc_parser 对命名空间比 epub crate 鲁棒）。返回 (标题, 归档内页路径, 深度)。
fn read_ncx_entries(doc: &mut EpubDoc<std::io::BufReader<std::fs::File>>) -> Vec<(String, String, usize)> {
    use crate::epub::toc_parser::parse_toc_content;
    use crate::models::TocNode;

    let root_file = doc.root_file.clone();
    let Some(opf) = doc.get_resource_str_by_path(&root_file) else {
        return Vec::new();
    };
    let Ok(spine_re) = regex::Regex::new(r#"(?is)<spine[^>]*\stoc\s*=\s*"([^"]+)""#) else {
        return Vec::new();
    };
    let Some(caps) = spine_re.captures(&opf) else {
        return Vec::new();
    };
    let Some((ncx_path, _)) = doc.resources.get(&caps[1]).cloned() else {
        return Vec::new();
    };
    let Some(ncx) = doc.get_resource_str_by_path(&ncx_path) else {
        return Vec::new();
    };
    let Ok(nodes) = parse_toc_content(&ncx) else {
        return Vec::new();
    };

    fn fl(nodes: &[TocNode], depth: usize, base: &Path, out: &mut Vec<(String, String, usize)>) {
        for n in nodes {
            // NCX src 相对 OPF 目录，join root_base 后与 get_current_path 同基准
            let full = base.join(&n.src).to_string_lossy().to_string();
            out.push((n.title.clone(), full, depth));
            fl(&n.children, depth + 1, base, out);
        }
    }
    let mut out = Vec::new();
    fl(&nodes, 0, &doc.root_base.clone(), &mut out);
    out
}

/// EPUB3 目录：manifest 中 properties="nav" 的页面 → nav.xhtml 解析。
fn read_nav_entries(doc: &mut EpubDoc<std::io::BufReader<std::fs::File>>) -> Vec<(String, String, usize)> {
    let root_file = doc.root_file.clone();
    let Some(opf) = doc.get_resource_str_by_path(&root_file) else {
        return Vec::new();
    };
    let Ok(item_re) = regex::Regex::new(r"(?is)<item\b[^>]*>") else {
        return Vec::new();
    };
    let Ok(href_re) = regex::Regex::new(r#"(?is)\bhref\s*=\s*"([^"]+)""#) else {
        return Vec::new();
    };
    let mut nav_path = None;
    for m in item_re.find_iter(&opf) {
        let tag = m.as_str();
        if tag.contains("properties=\"nav\"") || tag.contains("properties='nav'") {
            if let Some(h) = href_re.captures(tag) {
                nav_path = Some(doc.root_base.join(&h[1]));
                break;
            }
        }
    }
    let Some(nav_path) = nav_path else {
        return Vec::new();
    };
    let Some(nav) = doc.get_resource_str_by_path(&nav_path) else {
        return Vec::new();
    };
    parse_nav_toc(&nav, &doc.root_base)
}

/// nav.xhtml 的 toc 块解析：跟踪 <ol> 嵌套深度，取 <a href>标题。
fn parse_nav_toc(nav: &str, root_base: &Path) -> Vec<(String, String, usize)> {
    // 截取 epub:type="toc" 的 <nav> 块（找不到则全文扫）
    let lower = nav.to_lowercase();
    let scope = if let Some(type_pos) = lower.find("epub:type=\"toc\"") {
        let start = lower[..type_pos].rfind("<nav").unwrap_or(0);
        let end = lower[type_pos..]
            .find("</nav>")
            .map(|e| type_pos + e + "</nav>".len())
            .unwrap_or(nav.len());
        &nav[start..end]
    } else {
        nav
    };

    let Ok(tok_re) = regex::Regex::new(
        r#"(?is)(<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*>(.*?)</a>)|(<ol\b[^>]*>)|(</ol\s*>)"#,
    ) else {
        return Vec::new();
    };
    let Ok(tag_re) = regex::Regex::new(r"(?s)<[^>]+>") else {
        return Vec::new();
    };

    let mut out = Vec::new();
    let mut depth: i32 = 0;
    for m in tok_re.captures_iter(scope) {
        if m.get(4).is_some() {
            depth += 1;
        } else if m.get(5).is_some() {
            depth -= 1;
        } else if let (Some(h), Some(t)) = (m.get(2), m.get(3)) {
            let inner = tag_re.replace_all(t.as_str(), " ");
            let title = TextSanitizer::normalize_whitespace(&TextSanitizer::decode_html_entities(&inner));
            let title = title.trim();
            if !title.is_empty() {
                let full = root_base.join(h.as_str()).to_string_lossy().to_string();
                out.push((title.to_string(), full, (depth - 1).max(0) as usize));
            }
        }
    }
    out
}

#[cfg(test)]
mod search_text_tests {
    use super::EpubReader;
    use std::io::Write;
    use std::path::{Path, PathBuf};

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xedb8_8320 & (0u32.wrapping_sub(crc & 1)));
            }
        }
        !crc
    }

    fn push_u16(out: &mut Vec<u8>, value: u16) {
        out.extend_from_slice(&value.to_le_bytes());
    }

    fn push_u32(out: &mut Vec<u8>, value: u32) {
        out.extend_from_slice(&value.to_le_bytes());
    }

    fn stored_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, data) in entries {
            let offset = out.len() as u32;
            let crc = crc32(data);
            push_u32(&mut out, 0x0403_4b50);
            push_u16(&mut out, 20);
            push_u16(&mut out, 0);
            push_u16(&mut out, 0);
            push_u16(&mut out, 0);
            push_u16(&mut out, 0);
            push_u32(&mut out, crc);
            push_u32(&mut out, data.len() as u32);
            push_u32(&mut out, data.len() as u32);
            push_u16(&mut out, name.len() as u16);
            push_u16(&mut out, 0);
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(data);

            push_u32(&mut central, 0x0201_4b50);
            push_u16(&mut central, 20);
            push_u16(&mut central, 20);
            push_u16(&mut central, 0);
            push_u16(&mut central, 0);
            push_u16(&mut central, 0);
            push_u16(&mut central, 0);
            push_u32(&mut central, crc);
            push_u32(&mut central, data.len() as u32);
            push_u32(&mut central, data.len() as u32);
            push_u16(&mut central, name.len() as u16);
            push_u16(&mut central, 0);
            push_u16(&mut central, 0);
            push_u16(&mut central, 0);
            push_u16(&mut central, 0);
            push_u32(&mut central, 0);
            push_u32(&mut central, offset);
            central.extend_from_slice(name.as_bytes());
        }
        let central_offset = out.len() as u32;
        let central_size = central.len() as u32;
        out.extend_from_slice(&central);
        push_u32(&mut out, 0x0605_4b50);
        push_u16(&mut out, 0);
        push_u16(&mut out, 0);
        push_u16(&mut out, entries.len() as u16);
        push_u16(&mut out, entries.len() as u16);
        push_u32(&mut out, central_size);
        push_u32(&mut out, central_offset);
        push_u16(&mut out, 0);
        out
    }

    fn write_epub(dir: &Path) -> PathBuf {
        let container = r#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#;
        let manifest = (1..=4)
            .map(|index| format!(r#"<item id="ch{index}" href="ch{index}.xhtml" media-type="application/xhtml+xml"/>"#))
            .collect::<String>();
        let spine = (1..=4)
            .map(|index| format!(r#"<itemref idref="ch{index}"/>"#))
            .collect::<String>();
        let opf = format!(r#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>检索夹具</dc:title><dc:creator>测试</dc:creator><dc:language>zh</dc:language></metadata><manifest>{manifest}</manifest><spine>{spine}</spine></package>"#);
        let pages = [
            ("导论", "没有命中"),
            ("法律行为", "前文 意思表示 是核心，后文用于扩窗。"),
            ("意思表示 释义", "标题命中"),
            ("References", "ReferenceOnlyNeedle, Example Author, 2024."),
        ];
        let mut entries: Vec<(&str, &[u8])> = vec![
            ("mimetype", b"application/epub+zip"),
            ("META-INF/container.xml", container.as_bytes()),
            ("OEBPS/content.opf", opf.as_bytes()),
        ];
        let html = pages.map(|(heading, body)| {
            format!(r#"<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>{heading}</title></head><body><h1>{heading}</h1><p>{body}</p></body></html>"#)
        });
        let names = ["OEBPS/ch1.xhtml", "OEBPS/ch2.xhtml", "OEBPS/ch3.xhtml", "OEBPS/ch4.xhtml"];
        for (index, page) in html.iter().enumerate() {
            entries.push((names[index], page.as_bytes()));
        }
        let path = dir.join("search-fixture.epub");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(&stored_zip(&entries)).unwrap();
        path
    }

    #[test]
    fn search_text_returns_anchors_and_bounded_partial_without_offsets() {
        let dir = tempfile::tempdir().unwrap();
        let epub = write_epub(dir.path());
        let reader = EpubReader::new().unwrap();

        let full = reader.search_text(&epub, "意思表示", 30, None, None, false).unwrap();
        assert_eq!(full.scanned_sections, 4);
        assert!(!full.partial);
        assert_eq!(full.results.len(), 2);
        let body = full.results.iter().find(|hit| hit.match_kind == "keyword").unwrap();
        assert_eq!(body.heading, "法律行为");
        assert_eq!(body.spine, 1);
        assert!(body.snippet.contains("意思表示"));
        let title = full.results.iter().find(|hit| hit.match_kind == "title").unwrap();
        assert_eq!(title.spine, 2);
        let json = serde_json::to_value(&full).unwrap();
        assert_eq!(json["scanned_sections"], 4);
        assert!(json["results"][0].get("match_kind").is_some());
        assert!(json["results"][0].get("offset").is_none());

        let bounded = reader.search_text(&epub, "意思表示", 30, Some(2), None, false).unwrap();
        assert_eq!(bounded.scanned_sections, 2);
        assert!(bounded.partial);
        assert_eq!(bounded.results.len(), 1);
        assert_eq!(bounded.results[0].spine, 1);
    }

    #[test]
    fn search_text_reference_flag_changes_real_epub_results() {
        let dir = tempfile::tempdir().unwrap();
        let epub = write_epub(dir.path());
        let reader = EpubReader::new().unwrap();
        let excluded = reader.search_text(&epub, "ReferenceOnlyNeedle", 30, None, None, false).unwrap();
        let included = reader.search_text(&epub, "ReferenceOnlyNeedle", 30, None, None, true).unwrap();
        assert!(excluded.results.is_empty());
        assert_eq!(included.results.len(), 1);
        assert_eq!(included.results[0].spine, 3);
    }

    #[test]
    fn search_text_marks_body_extraction_failure_partial_and_keeps_heading_hit() {
        let dir = tempfile::tempdir().unwrap();
        let epub = write_epub(dir.path());
        let reader = EpubReader::new().unwrap();
        let result = reader
            .search_text_with_extractor(&epub, "意思表示 释义", 30, None, None, false, |html| {
                if html.contains("<p>标题命中</p>") {
                    Err(anyhow::anyhow!("injected body extraction failure"))
                } else {
                    reader.extract_text_content(html)
                }
            })
            .unwrap();
        assert_eq!(result.scanned_sections, 4);
        assert!(result.partial, "failed body extraction must make coverage partial");
        assert_eq!(result.results.len(), 1, "a valid heading hit must survive body failure");
        assert_eq!(result.results[0].match_kind, "title");
        assert_eq!(result.results[0].spine, 2);
    }
}
