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
