#!/usr/bin/env python3
"""生成迷你 Zotero 7 库 fixture（仅 Python stdlib）。

用法：python scripts/make-zotero-fixture.py <输出目录>

生成 <输出目录>/zotero.sqlite + storage/{附件key}/xxx.pdf，结构与数据：
- collection A「材料学」（含子 collection B「纳米材料」）
- 条目 1 ITEM0001：A 下，有 PDF，DOI=10.1/abc，标题 "Study of Flame Synthesis"，作者 San Zhang，date=2016
- 条目 2 ITEM0002：B 下，有 PDF
- 条目 3 ITEM0003：A+B 同时归属，无 PDF 附件
- 条目 4 ITEM0004：无归属（「未分类」），有 PDF

表结构对齐真实 Zotero 7 schema 的关键列（zotero_scan_library 只读这些列）；
字段/类型按名字关联（fields.fieldName、itemTypes.typeName），ID 为夹具内自洽值。
"""
import os
import sqlite3
import sys

PDF_BYTES = b"%PDF-1.4 fixture\n"

SCHEMA = """
CREATE TABLE libraries (
    libraryID INTEGER PRIMARY KEY,
    type TEXT NOT NULL
);
CREATE TABLE collections (
    collectionID INTEGER PRIMARY KEY,
    collectionName TEXT NOT NULL,
    parentCollectionID INTEGER REFERENCES collections(collectionID),
    libraryID INTEGER NOT NULL REFERENCES libraries(libraryID),
    key TEXT NOT NULL
);
CREATE TABLE collectionItems (
    collectionID INTEGER NOT NULL REFERENCES collections(collectionID),
    itemID INTEGER NOT NULL REFERENCES items(itemID),
    orderIndex INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (collectionID, itemID)
);
CREATE TABLE items (
    itemID INTEGER PRIMARY KEY,
    itemTypeID INTEGER NOT NULL REFERENCES itemTypes(itemTypeID),
    libraryID INTEGER NOT NULL REFERENCES libraries(libraryID),
    key TEXT NOT NULL
);
CREATE TABLE itemTypes (
    itemTypeID INTEGER PRIMARY KEY,
    typeName TEXT NOT NULL
);
CREATE TABLE itemData (
    itemID INTEGER NOT NULL REFERENCES items(itemID),
    fieldID INTEGER NOT NULL REFERENCES fields(fieldID),
    valueID INTEGER NOT NULL REFERENCES itemDataValues(valueID),
    PRIMARY KEY (itemID, fieldID)
);
CREATE TABLE itemDataValues (
    valueID INTEGER PRIMARY KEY,
    value TEXT
);
CREATE TABLE fields (
    fieldID INTEGER PRIMARY KEY,
    fieldName TEXT NOT NULL
);
CREATE TABLE itemCreators (
    itemID INTEGER NOT NULL REFERENCES items(itemID),
    creatorID INTEGER NOT NULL REFERENCES creators(creatorID),
    creatorTypeID INTEGER NOT NULL,
    orderIndex INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (itemID, creatorID, orderIndex)
);
CREATE TABLE creators (
    creatorID INTEGER PRIMARY KEY,
    firstName TEXT,
    lastName TEXT,
    fieldMode INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE itemAttachments (
    itemID INTEGER PRIMARY KEY REFERENCES items(itemID),
    parentItemID INTEGER REFERENCES items(itemID),
    linkMode INTEGER NOT NULL,
    contentType TEXT,
    path TEXT
);
CREATE TABLE deletedItems (
    itemID INTEGER PRIMARY KEY
);
"""

# itemTypeID：journalArticle=2 为真实 Zotero 值；attachment/note 取夹具内自洽值
TYPE_JOURNAL_ARTICLE = 2
TYPE_ATTACHMENT = 3
TYPE_NOTE = 4

# fieldID：名字关联，ID 自洽即可
FIELD_TITLE = 1
FIELD_DOI = 2
FIELD_DATE = 3

LIBRARY_USER = 1
CREATOR_TYPE_AUTHOR = 1
LINK_MODE_IMPORTED_FILE = 0


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    db_path = os.path.join(out_dir, "zotero.sqlite")
    if os.path.exists(db_path):
        os.remove(db_path)

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.executescript(SCHEMA)

    cur.execute("INSERT INTO libraries (libraryID, type) VALUES (?, 'user')", (LIBRARY_USER,))
    cur.executemany(
        "INSERT INTO itemTypes (itemTypeID, typeName) VALUES (?, ?)",
        [(TYPE_JOURNAL_ARTICLE, "journalArticle"), (TYPE_ATTACHMENT, "attachment"), (TYPE_NOTE, "note")],
    )
    cur.executemany(
        "INSERT INTO fields (fieldID, fieldName) VALUES (?, ?)",
        [(FIELD_TITLE, "title"), (FIELD_DOI, "DOI"), (FIELD_DATE, "date")],
    )

    # Collection A「材料学」+ 子 collection B「纳米材料」（key 为 8 位，同真实 Zotero）
    cur.executemany(
        "INSERT INTO collections (collectionID, collectionName, parentCollectionID, libraryID, key) VALUES (?, ?, ?, ?, ?)",
        [
            (1, "材料学", None, LIBRARY_USER, "COLL0001"),
            (2, "纳米材料", 1, LIBRARY_USER, "COLL0002"),
        ],
    )

    # 条目（journalArticle）：itemID/key/标题/DOI/date/作者(firstName,lastName)/PDF 文件名
    articles = [
        (1, "ITEM0001", "Study of Flame Synthesis", "10.1/abc", "2016", ("San", "Zhang"), "flame.pdf"),
        (2, "ITEM0002", "Nanoscale Heat Transfer in Films", None, "2020", ("Wei", "Li"), "nano.pdf"),
        (3, "ITEM0003", "Review of Catalytic Nanomaterials", None, "2019", ("Mei", "Wang"), None),
        (4, "ITEM0004", "Standalone PDF Study", None, "2021", ("Tom", "Liu"), "standalone.pdf"),
    ]
    next_value_id = 1
    next_creator_id = 1
    for item_id, key, title, doi, date, author, pdf_name in articles:
        cur.execute(
            "INSERT INTO items (itemID, itemTypeID, libraryID, key) VALUES (?, ?, ?, ?)",
            (item_id, TYPE_JOURNAL_ARTICLE, LIBRARY_USER, key),
        )
        for field_id, value in ((FIELD_TITLE, title), (FIELD_DOI, doi), (FIELD_DATE, date)):
            if value is None:
                continue
            cur.execute("INSERT INTO itemDataValues (valueID, value) VALUES (?, ?)", (next_value_id, value))
            cur.execute(
                "INSERT INTO itemData (itemID, fieldID, valueID) VALUES (?, ?, ?)",
                (item_id, field_id, next_value_id),
            )
            next_value_id += 1
        cur.execute(
            "INSERT INTO creators (creatorID, firstName, lastName, fieldMode) VALUES (?, ?, ?, 0)",
            (next_creator_id, author[0], author[1]),
        )
        cur.execute(
            "INSERT INTO itemCreators (itemID, creatorID, creatorTypeID, orderIndex) VALUES (?, ?, ?, 0)",
            (item_id, next_creator_id, CREATOR_TYPE_AUTHOR),
        )
        next_creator_id += 1

    # Collection 归属：条目 1→A；条目 2→B；条目 3→A+B；条目 4 无归属
    cur.executemany(
        "INSERT INTO collectionItems (collectionID, itemID, orderIndex) VALUES (?, ?, ?)",
        [(1, 1, 0), (2, 2, 0), (1, 3, 0), (2, 3, 1)],
    )

    # PDF 附件（attachment item + itemAttachments + storage 文件；path 用 storage: 形式，linkMode=0）
    attachments = [
        (101, "ATTC0001", 1, "flame.pdf"),
        (102, "ATTC0002", 2, "nano.pdf"),
        (104, "ATTC0004", 4, "standalone.pdf"),
    ]
    for att_id, att_key, parent_id, pdf_name in attachments:
        cur.execute(
            "INSERT INTO items (itemID, itemTypeID, libraryID, key) VALUES (?, ?, ?, ?)",
            (att_id, TYPE_ATTACHMENT, LIBRARY_USER, att_key),
        )
        cur.execute(
            "INSERT INTO itemAttachments (itemID, parentItemID, linkMode, contentType, path) VALUES (?, ?, ?, ?, ?)",
            (att_id, parent_id, LINK_MODE_IMPORTED_FILE, "application/pdf", f"storage:{pdf_name}"),
        )
        att_dir = os.path.join(out_dir, "storage", att_key)
        os.makedirs(att_dir, exist_ok=True)
        with open(os.path.join(att_dir, pdf_name), "wb") as f:
            f.write(PDF_BYTES)

    conn.commit()
    conn.close()
    print(f"fixture written: {db_path}")
    print("collections: 材料学(2 篇) > 纳米材料(2 篇)；未分类 1 篇；附件 3 个")
    return 0


if __name__ == "__main__":
    sys.exit(main())
