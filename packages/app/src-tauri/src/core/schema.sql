-- 注意：threads.starred、books.trashed_at 列由 database.rs 的 fork 专属迁移添加，勿在此定义（避免与 ALTER 重复）
CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT,
    metadata TEXT NOT NULL,
    title TEXT NOT NULL,
    messages TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    format TEXT NOT NULL,
    file_path TEXT NOT NULL,
    cover_path TEXT,
    
    file_size INTEGER NOT NULL,
    language TEXT NOT NULL,
    
    tags TEXT,
    
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS book_status (
    book_id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL DEFAULT 'unread',  -- 'unread', 'reading', 'completed'
    progress_current INTEGER DEFAULT 0,
    progress_total INTEGER DEFAULT 0,
    location TEXT,                           -- CFI 位置信息
    rating INTEGER NOT NULL DEFAULT 0,       -- 重要度打星（0-3，0=未打星）
    last_read_at INTEGER,
    started_at INTEGER,
    completed_at INTEGER,
    metadata TEXT,                 -- JSON 存储其他信息（设置、偏好等）
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

-- 阅读会话表 - 记录每次详细的阅读会话
CREATE TABLE IF NOT EXISTS reading_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,            -- 开始阅读时间戳
    ended_at INTEGER,                       -- 结束阅读时间戳（null表示未结束）
    duration_seconds INTEGER DEFAULT 0,     -- 实际阅读时长（秒）
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);



CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
CREATE INDEX IF NOT EXISTS idx_books_updated_at ON books(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_book_status_status ON book_status(status);
CREATE INDEX IF NOT EXISTS idx_book_status_progress ON book_status(progress_current, progress_total);
CREATE INDEX IF NOT EXISTS idx_book_status_location ON book_status(location);
CREATE INDEX IF NOT EXISTS idx_book_status_last_read ON book_status(last_read_at DESC);
CREATE INDEX IF NOT EXISTS idx_book_status_updated_at ON book_status(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_threads_book_id ON threads(book_id);

-- reading_sessions 表的索引
CREATE INDEX IF NOT EXISTS idx_reading_sessions_book_id ON reading_sessions(book_id);
CREATE INDEX IF NOT EXISTS idx_reading_sessions_started_at ON reading_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_reading_sessions_date ON reading_sessions(DATE(started_at/1000, 'unixepoch'));
CREATE INDEX IF NOT EXISTS idx_reading_sessions_book_date ON reading_sessions(book_id, DATE(started_at/1000, 'unixepoch'));

CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL UNIQUE,
    color TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
CREATE INDEX IF NOT EXISTS idx_tags_updated_at ON tags(updated_at DESC);

-- BookNote 表 - 存储书籍标注、书签、摘录等
CREATE TABLE IF NOT EXISTS book_notes (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT NOT NULL,
    type TEXT NOT NULL,                    -- 笔记类型: bookmark|annotation|excerpt
    cfi TEXT NOT NULL,                     -- 位置信息 (CFI格式)
    text TEXT,                             -- 选中的文本内容
    style TEXT,                            -- 高亮样式: highlight|underline|squiggly
    color TEXT,                            -- 颜色: red|yellow|green|blue|violet
    note TEXT NOT NULL,                    -- 用户笔记内容
    context_before TEXT,                   -- 前文上下文
    context_after TEXT,                    -- 后文上下文
    created_at INTEGER NOT NULL,           -- 创建时间戳
    updated_at INTEGER NOT NULL,           -- 更新时间戳
    
    -- 外键约束
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

-- book_notes 表的索引
CREATE INDEX IF NOT EXISTS idx_book_notes_book_id ON book_notes(book_id);
CREATE INDEX IF NOT EXISTS idx_book_notes_type ON book_notes(type);
CREATE INDEX IF NOT EXISTS idx_book_notes_created_at ON book_notes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_book_notes_cfi ON book_notes(cfi);

-- Note 表 - 笔记面板（2026-08 重建）：绑定书籍/论文的长文 Markdown 笔记，与 book_notes 标注是两套概念
-- 位置三列：location_cfi 精确锚点（论文=heading slug；书籍=CFI）、location_tag 文本兜底（heading/章节标题）、location_block 阅读流排序键
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    location_tag TEXT,
    location_block INTEGER,
    location_cfi TEXT,
    starred INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,

    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notes_book_id ON notes(book_id);

-- 技能库表 - 存储 AI 技能的标准操作流程
CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL UNIQUE,             -- 技能名称（如：生成思维导图）
    content TEXT NOT NULL,                 -- 技能内容（Markdown 格式的完整说明）
    is_active INTEGER DEFAULT 1,           -- 是否启用（1=启用，0=禁用）
    is_system INTEGER DEFAULT 0,           -- 是否为系统技能（1=系统，0=用户，系统技能不可删除）
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- skills 表的索引
CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
CREATE INDEX IF NOT EXISTS idx_skills_is_active ON skills(is_active);
CREATE INDEX IF NOT EXISTS idx_skills_updated_at ON skills(updated_at DESC);

-- AI 用量流水表（2026-08-28 统计面板）：每条 AI 回复 finish 落一行，聚合在前端做
-- 纯统计数据，不参与 L2 同步（与 reading_sessions 同级的地方性数据）
CREATE TABLE IF NOT EXISTS ai_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT,
    scope TEXT NOT NULL DEFAULT 'reader',     -- reader | paper | central
    provider_id TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL               -- ms epoch，统计聚合锚点
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_created_at ON ai_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_model ON ai_usage(model_id);