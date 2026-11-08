import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("prepare-preview-copy.py")
spec = importlib.util.spec_from_file_location("prepare_preview_copy", MODULE_PATH)
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


def make_app_db(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with preview.managed_sqlite(sqlite3.connect(path)) as db:
        db.executescript(
            "CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT, format TEXT, file_path TEXT, cover_path TEXT);"
            "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT);"
            "CREATE TABLE _sync_log (seq INTEGER PRIMARY KEY, row_id TEXT);"
        )
        db.executemany("INSERT INTO books VALUES (?, ?, ?, ?, ?)", rows)
        db.execute("INSERT INTO _sync_log(row_id) VALUES ('do-not-copy')")


def make_vector_db(path, source_root, book_id):
    with preview.managed_sqlite(sqlite3.connect(path)) as db:
        db.execute(
            "CREATE TABLE document_chunks (id INTEGER PRIMARY KEY, book_title TEXT, book_author TEXT,"
            " md_file_path TEXT UNIQUE, chunk_text TEXT)"
        )
        db.execute("CREATE TABLE bm25_stats (total_docs INTEGER, avg_doc_length REAL, updated_at TEXT)")
        absolute = source_root / "books" / book_id / "mdbook" / "chapter_000.md"
        db.execute(
            "INSERT INTO document_chunks(book_title, book_author, md_file_path, chunk_text) VALUES (?, ?, ?, ?)",
            ("测试书", "作者", str(absolute), "向量对应正文"),
        )
        db.execute("INSERT INTO document_chunks(book_title, book_author, md_file_path, chunk_text) VALUES (?, ?, ?, ?)",
                   ("相对", "作者", "books/relative.md", "相对路径不变"))
        db.execute("INSERT INTO bm25_stats VALUES (2, 4.0, 'now')")


class PreviewDataTests(unittest.TestCase):
    def test_sanitize_config_removes_secrets_but_preserves_references_and_settings(self):
        source = {
            "state": {
                "modelProviders": [{"apiKey": "fixture-secret", "baseUrl": "https://api.stepfun.com/v1"}],
                "password": "fixture-password",
                "authorization": "{{secret:ALLOWED_REFERENCE}}",
                "maxOutputTokens": 2048,
            }
        }
        cleaned, count = preview.sanitize_config(source)
        self.assertEqual(count, 2)
        self.assertEqual(cleaned["state"]["modelProviders"][0]["apiKey"], "")
        self.assertEqual(cleaned["state"]["password"], "")
        self.assertEqual(cleaned["state"]["authorization"], "{{secret:ALLOWED_REFERENCE}}")
        self.assertEqual(cleaned["state"]["modelProviders"][0]["baseUrl"], "https://api.stepfun.com/v1")
        self.assertEqual(cleaned["state"]["maxOutputTokens"], 2048)
        self.assertEqual(source["state"]["modelProviders"][0]["apiKey"], "fixture-secret")

    def test_raw_backup_accepts_individual_config_files(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "settings.json"
            target = Path(temp) / "backup" / "settings.json"
            source.write_text('{"state":{"theme":"dark"}}', encoding="utf-8")
            preview.copy_raw_tree(source, target)
            self.assertEqual(json.loads(target.read_text(encoding="utf-8"))["state"]["theme"], "dark")

    def test_online_snapshot_contains_committed_wal_rows(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "source.db"
            target = Path(temp) / "target.db"
            with preview.managed_sqlite(sqlite3.connect(source)) as db:
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("CREATE TABLE entries (id TEXT)")
                db.execute("INSERT INTO entries VALUES ('committed-in-wal')")
            preview.snapshot_sqlite(source, target)
            with preview.managed_sqlite(sqlite3.connect(target)) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM entries").fetchone()[0], 1)
                self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_snapshot_can_restore_while_another_connection_holds_the_database(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "source.db"
            target = Path(temp) / "target.db"
            with preview.managed_sqlite(sqlite3.connect(source)) as db:
                db.execute("CREATE TABLE entries (id TEXT)")
                db.execute("INSERT INTO entries VALUES ('from-backup')")
            with preview.managed_sqlite(sqlite3.connect(target)) as db:
                db.execute("CREATE TABLE obsolete (id TEXT)")
                db.execute("INSERT INTO obsolete VALUES ('old')")
            with preview.managed_sqlite(sqlite3.connect(target)) as reader:
                self.assertEqual(reader.execute("SELECT count(*) FROM obsolete").fetchone()[0], 1)
                preview.snapshot_sqlite(source, target)
            with preview.managed_sqlite(sqlite3.connect(target)) as db:
                self.assertEqual(db.execute("SELECT id FROM entries").fetchone()[0], "from-backup")
                self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_restore_finishes_wal_without_deleting_a_readers_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            backup = root / "backup"
            backup.mkdir()
            make_app_db(backup / "target-app.db", [])
            with preview.managed_sqlite(sqlite3.connect(backup / "target-app.db")) as db:
                db.execute("INSERT INTO threads VALUES ('original-thread', '保留')")
            target = root / "preview"
            (target / "database").mkdir(parents=True)
            make_app_db(target / "database" / "app.db", [])
            with preview.managed_sqlite(sqlite3.connect(target / "database" / "app.db")) as reader:
                reader.execute("PRAGMA journal_mode=WAL")
                reader.execute("INSERT INTO threads VALUES ('changed-thread', '回滚我')")
                reader.commit()
                reader.execute("SELECT count(*) FROM threads").fetchall()
                preview.restore_inputs(target, backup, set(), set())
                titles = [row[0] for row in reader.execute("SELECT id FROM threads")]
                self.assertEqual(titles, ["original-thread"])

    def test_vector_paths_are_remapped_without_touching_relative_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "dev"
            target = Path(temp) / "preview"
            source_book = source / "books" / "book-id"
            source_book.mkdir(parents=True)
            (source_book / "vectors.sqlite").touch()
            make_vector_db(source_book / "vectors.sqlite", source, "book-id")
            preview.copy_asset_tree(source / "books", target / "books")
            with preview.managed_sqlite(sqlite3.connect(target / "books" / "book-id" / "vectors.sqlite")) as db:
                rows = db.execute("SELECT md_file_path FROM document_chunks ORDER BY id").fetchall()
            self.assertEqual(rows[0][0], str(target / "books" / "book-id" / "mdbook" / "chapter_000.md"))
            self.assertEqual(rows[1][0], "books/relative.md")

    def test_metadata_paths_are_remapped_without_touching_source_or_external_links(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "dev"
            target = Path(temp) / "preview"
            book = source / "books" / "book-id"
            book.mkdir(parents=True)
            metadata = {
                "title": "书",
                "base_dir": str(book / "mdbook" / "book" / "src" / "EPUB"),
                "zotero_pdf_path": "C:/Zotero/storage/paper.pdf",
            }
            (book / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
            preview.copy_asset_tree(source / "books", target / "books")
            copied = json.loads((target / "books" / "book-id" / "metadata.json").read_text(encoding="utf-8"))
            expected = str(target / "books" / "book-id" / "mdbook" / "book" / "src" / "EPUB")
            self.assertEqual(copied["base_dir"], expected)
            self.assertEqual(copied["zotero_pdf_path"], "C:/Zotero/storage/paper.pdf")
            original = json.loads((book / "metadata.json").read_text(encoding="utf-8"))
            self.assertEqual(original, metadata)

    def test_unknown_absolute_metadata_base_dir_aborts_copy(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "dev"
            target = Path(temp) / "preview"
            book = source / "books" / "book-id"
            book.mkdir(parents=True)
            metadata = {"title": "书", "base_dir": str(Path(temp) / "elsewhere" / "mdbook")}
            (book / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "源目录之外"):
                preview.copy_asset_tree(source / "books", target / "books")
            self.assertFalse((target / "books" / "book-id" / "metadata.json").exists())

    def test_legacy_application_paths_are_mapped_to_the_preview(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "com.bettersageread.dev"
            legacy = Path(temp) / "com.xincmm.sageread"
            target = Path(temp) / "com.bettersageread.preview"
            book = source / "books" / "book-id"
            book.mkdir(parents=True)
            chapter = book / "mdbook" / "chapter_000.md"
            chapter.parent.mkdir(parents=True)
            chapter.write_text("正文", encoding="utf-8")
            make_vector_db(book / "vectors.sqlite", legacy, "book-id")
            preview.copy_asset_tree(source / "books", target / "books")
            with preview.managed_sqlite(sqlite3.connect(target / "books" / "book-id" / "vectors.sqlite")) as db:
                paths = [row[0] for row in db.execute("SELECT md_file_path FROM document_chunks ORDER BY id")]
            self.assertEqual(paths[0], str(target / "books" / "book-id" / "mdbook" / "chapter_000.md"))
            self.assertEqual(paths[1], "books/relative.md")
            self.assertTrue(Path(paths[0]).is_file())

    def test_legacy_dev_vector_paths_reuse_existing_current_assets(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "com.bettersageread.dev"
            legacy = Path(temp) / "com.xincmm.sageread.dev"
            target = Path(temp) / "com.bettersageread.preview"
            paper = source / "books" / "paper-id" / "paper.md"
            paper.parent.mkdir(parents=True)
            paper.write_text("# 当前正文", encoding="utf-8")
            (source / "papers").mkdir(parents=True)
            make_vector_db(source / "papers" / "vectors.sqlite", legacy, "paper-id")
            with preview.managed_sqlite(sqlite3.connect(source / "papers" / "vectors.sqlite")) as db:
                db.execute(
                    "UPDATE document_chunks SET md_file_path=? WHERE book_title='测试书'",
                    (str(legacy / "books" / "paper-id" / "paper.md"),),
                )
            preview.copy_asset_tree(source / "books", target / "books")
            preview.copy_asset_tree(source / "papers", target / "papers")
            with preview.managed_sqlite(sqlite3.connect(target / "papers" / "vectors.sqlite")) as db:
                path = db.execute("SELECT md_file_path FROM document_chunks WHERE book_title='测试书'").fetchone()[0]
            self.assertEqual(path, str(target / "books" / "paper-id" / "paper.md"))
            self.assertTrue(Path(path).is_file())

    def test_stale_manual_index_is_regenerated_not_copied(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "dev"
            target = Path(temp) / "preview"
            manual = source / "books" / "__app_manual__"
            manual.mkdir(parents=True)
            make_vector_db(manual / "vectors.sqlite", source, "__app_manual__")
            result = preview.copy_asset_tree(source / "books", target / "books")
            self.assertFalse((target / "books" / "__app_manual__" / "vectors.sqlite").exists())
            self.assertTrue((manual / "vectors.sqlite").is_file())
            self.assertEqual(result["skipped"], ["books/__app_manual__/vectors.sqlite"])

    def test_merge_preserves_target_records_and_skips_sync_state(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "source.db"
            target = Path(temp) / "target.db"
            make_app_db(source, [("source-book", "来源", "EPUB", "books/source/book.epub", "")])
            make_app_db(target, [("target-book", "目标", "MARKDOWN", "books/target/paper.md", "")])
            with preview.managed_sqlite(sqlite3.connect(source)) as db:
                db.executemany("INSERT INTO threads VALUES (?, ?)", [("shared", "source-version"), ("source-only", "来源保留")])
            with preview.managed_sqlite(sqlite3.connect(target)) as db:
                db.executemany("INSERT INTO threads VALUES (?, ?)", [("shared", "target-version"), ("target-only", "目标保留")])
            preview.merge_databases(source, target)
            with preview.managed_sqlite(sqlite3.connect(target)) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM books").fetchone()[0], 2)
                self.assertEqual(db.execute("SELECT title FROM threads WHERE id='shared'").fetchone()[0], "target-version")
                self.assertEqual(db.execute("SELECT count(*) FROM threads").fetchone()[0], 3)
                self.assertEqual(db.execute("SELECT count(*) FROM _sync_log").fetchone()[0], 1)
                self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_agent_workspace_is_preview_local_and_strict_mode_is_retained(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "preview"
            result = preview.remap_agent_settings(
                {"state": {"workspaceRoot": "F:/daily", "perAgentRoots": {"central": "F:/other"}, "safetyMode": "full"}},
                target,
                {"state": {"safetyMode": "strict"}},
            )
            self.assertEqual(result["state"]["workspaceRoot"], str(target / "agent-workspace"))
            self.assertEqual(result["state"]["perAgentRoots"], {})
            self.assertEqual(result["state"]["safetyMode"], "strict")

    def test_apply_requires_stopped_app_and_writes_a_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "dev"
            target = root / "preview"
            (source / "database").mkdir(parents=True)
            (source / "books" / "book-id" / "mdbook").mkdir(parents=True)
            (source / "papers").mkdir()
            (target / "database").mkdir(parents=True)
            (source / "agent-settings.json").write_text(json.dumps({"state": {"workspaceRoot": None}}), encoding="utf-8")
            (source / "app-settings.json").write_text(json.dumps({"state": {"theme": "dark"}}), encoding="utf-8")
            (source / "books" / "book-id" / "book.epub").write_bytes(b"book")
            (source / "books" / "book-id" / "mdbook" / "chapter_000.md").write_text("正文", encoding="utf-8")
            (source / "books" / "relative.md").write_text("相对正文", encoding="utf-8")
            make_vector_db(source / "books" / "book-id" / "vectors.sqlite", source, "book-id")
            make_app_db(source / "database" / "app.db", [("book-id", "来源", "EPUB", "books/book-id/book.epub", "")])
            make_app_db(target / "database" / "app.db", [])
            with preview.managed_sqlite(sqlite3.connect(target / "database" / "app.db")) as db:
                db.execute("INSERT INTO threads VALUES ('target-thread', '保留我')")
            with self.assertRaises(ValueError):
                preview.prepare_preview_copy(source, target, root / "backup", apply=True, confirm_stopped=False)
            manifest = preview.prepare_preview_copy(source, target, root / "backup", apply=True, confirm_stopped=True)
            self.assertTrue((target / "books" / "book-id" / "book.epub").exists())
            self.assertTrue((target / "agent-settings.json").exists())
            with preview.managed_sqlite(sqlite3.connect(target / "database" / "app.db")) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM books").fetchone()[0], 1)
                self.assertEqual(db.execute("SELECT count(*) FROM threads").fetchone()[0], 1)
            self.assertEqual(manifest["source_books"], 1)
            self.assertTrue((root / "backup" / "manifest.json").exists())
    def test_retry_cannot_overwrite_the_original_backup_baseline(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "dev"
            target = root / "preview"
            (source / "database").mkdir(parents=True)
            (target / "database").mkdir(parents=True)
            make_app_db(source / "database" / "app.db", [])
            make_app_db(target / "database" / "app.db", [])
            backup = root / "backup"
            make_app_db(backup / "target-app.db", [])
            with preview.managed_sqlite(sqlite3.connect(backup / "target-app.db")) as db:
                db.execute("INSERT INTO threads VALUES ('first-backup', '不许覆盖')")
            with self.assertRaises(FileExistsError):
                preview.prepare_preview_copy(source, target, backup, apply=True, confirm_stopped=True)
            with preview.managed_sqlite(sqlite3.connect(backup / "target-app.db")) as db:
                self.assertEqual(db.execute("SELECT id FROM threads").fetchone()[0], "first-backup")


if __name__ == "__main__":
    unittest.main()
