import argparse
import json
import ntpath
import re
import shutil
import sqlite3
import tempfile
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path


@contextmanager
def managed_sqlite(connection):
    try:
        with connection:
            yield connection
    finally:
        connection.close()


CONFIG_FILES = (
    "app-settings.json",
    "agent-settings.json",
    "chat-settings.json",
    "layout-store.json",
    "quick-commands.json",
    "model-provider.json",
    "llama-store.json",
    "converter-store.json",
    "mcp-servers.json",
    "proxy.json",
)
ASSET_DIRS = ("books", "papers", "attachments", "fonts", "themes", "reader-backgrounds")
SENSITIVE_NAME = re.compile(r"(?:api[_-]?key|token|secret|password|passwd|authorization|cookie|credential|private[_-]?key)", re.I)
SECRET_REFERENCE = re.compile(r"^\{\{secret:[A-Za-z0-9_-]+\}\}$")
SKIP_TABLES = {"_sync_log", "sqlite_sequence"}


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def sanitize_config(value):
    redactions = 0

    def clean(item, key=""):
        nonlocal redactions
        if isinstance(item, dict):
            return {name: clean(child, name) for name, child in item.items()}
        if isinstance(item, list):
            return [clean(child, key) for child in item]
        if isinstance(item, str) and SENSITIVE_NAME.search(key) and not SECRET_REFERENCE.fullmatch(item):
            redactions += 1
            return ""
        return item

    return clean(value), redactions


def remap_agent_settings(data, target_root, existing=None):
    result, _ = sanitize_config(data)
    state = result.get("state", result)
    state["workspaceRoot"] = str(target_root / "agent-workspace")
    state["perAgentRoots"] = {}
    existing_safety = (existing or {}).get("state", {}).get("safetyMode")
    state["safetyMode"] = existing_safety or "strict"
    return result


def sqlite_uri(path):
    return f"{path.resolve().as_uri()}?mode=ro"


def open_readonly(path):
    return sqlite3.connect(sqlite_uri(path), uri=True)


def check_integrity(db):
    result = db.execute("PRAGMA integrity_check").fetchone()
    if not result or result[0] != "ok":
        raise ValueError(f"SQLite integrity check failed: {result}")


def checkpoint_sqlite(path):
    with managed_sqlite(sqlite3.connect(path, timeout=30)) as db:
        db.execute("PRAGMA busy_timeout=30000")
        result = db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        if not result or result[0] != 0:
            raise ValueError(f"SQLite 日志检查点未完成，保持备份供重试: {result}")


def restore_sqlite_online(source, destination):
    with managed_sqlite(open_readonly(Path(source))) as source_db:
        with managed_sqlite(sqlite3.connect(destination, timeout=30)) as target_db:
            source_db.backup(target_db)
            target_db.commit()
            check_integrity(target_db)


def snapshot_sqlite(source, destination):
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=".snapshot-", suffix=".db", delete=False) as handle:
        temporary = Path(handle.name)
    source_db = None
    target_db = None
    try:
        source_db = open_readonly(Path(source))
        target_db = sqlite3.connect(temporary)
        source_db.backup(target_db)
        target_db.commit()
        check_integrity(target_db)
        source_db.close()
        source_db = None
        target_db.close()
        target_db = None
        try:
            temporary.replace(destination)
        except PermissionError:
            if not destination.is_file():
                raise
            restore_sqlite_online(temporary, destination)
    finally:
        if source_db is not None:
            source_db.close()
        if target_db is not None:
            target_db.close()
        temporary.unlink(missing_ok=True)


def path_prefixes(root):
    native = str(root).rstrip("\\/")
    return ((native, native), (native.replace("\\", "/"), native.replace("\\", "/")))


def remap_path(value, source_root, target_root, legacy_roots=()):
    if not value or not (ntpath.isabs(value) or value.startswith("/")):
        return value
    for source in (source_root, *legacy_roots):
        for native, normalized in path_prefixes(source):
            if value == native or value.startswith(native + "\\") or value.startswith(native + "/"):
                prefix = str(target_root).rstrip("\\/") if native == normalized else str(target_root).rstrip("\\/").replace("\\", "/")
                return prefix + value[len(native):]
    raise ValueError("资产包含源目录之外的绝对路径，未进行隐式映射")


def rewrite_vector_paths(path, source_root, target_root, legacy_roots=()):
    with managed_sqlite(sqlite3.connect(path)) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "document_chunks" not in tables:
            return
        values = [row[0] for row in db.execute("SELECT DISTINCT md_file_path FROM document_chunks")]
        for value in values:
            if not value or not (ntpath.isabs(value) or value.startswith("/")):
                continue
            mapped = remap_path(value, source_root, target_root, legacy_roots)
            if mapped != value:
                db.execute("UPDATE document_chunks SET md_file_path=? WHERE md_file_path=?", (mapped, value))
        db.commit()
        check_integrity(db)
        for old, _ in path_prefixes(source_root):
            if db.execute("SELECT count(*) FROM document_chunks WHERE instr(md_file_path, ?) > 0", (old,)).fetchone()[0]:
                raise ValueError("向量索引仍引用原应用目录")


def manual_index_needs_rebuild(path, root):
    with managed_sqlite(open_readonly(path)) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "document_chunks" not in tables:
            return True
        values = [row[0] for row in db.execute("SELECT DISTINCT md_file_path FROM document_chunks")]
    missing = False
    legacy_roots = (root.with_name("com.xincmm.sageread"), root.with_name("com.xincmm.sageread.dev"))
    for value in values:
        if not value:
            continue
        mapped = remap_path(value, root, root, legacy_roots) if ntpath.isabs(value) or value.startswith("/") else str(root / value)
        if not Path(mapped).is_file():
            missing = True
    return missing


def copy_metadata_file(source, target, source_root, target_root):
    data = read_json(source)
    if isinstance(data.get("base_dir"), str):
        legacy_roots = (source_root.with_name("com.xincmm.sageread"), source_root.with_name("com.xincmm.sageread.dev"))
        data["base_dir"] = remap_path(data["base_dir"], source_root, target_root, legacy_roots)
    write_json(target, data)


def copy_asset_tree(source_root, target_root):
    source_root = Path(source_root)
    target_root = Path(target_root)
    if not source_root.exists():
        return {"files": 0, "bytes": 0}
    copied = {"files": 0, "bytes": 0, "skipped": []}
    for source in source_root.rglob("*"):
        if source.is_symlink():
            raise ValueError(f"资产目录不允许符号链接: {source}")
        if not source.is_file() or source.name in {".env", "secrets-fallback.json", "sync-state.json"}:
            continue
        if source.suffix in {"-wal", "-shm", ".tmp"} or source.name.endswith(("-wal", "-shm", ".tmp")):
            continue
        relative = source.relative_to(source_root)
        if relative.as_posix() == "__app_manual__/vectors.sqlite" and manual_index_needs_rebuild(source, source_root.parent):
            copied["skipped"].append(f"{source_root.name}/{relative.as_posix()}")
            continue
        target = target_root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.suffix.lower() in {".sqlite", ".db"}:
            snapshot_sqlite(source, target)
            with managed_sqlite(sqlite3.connect(target)) as db:
                tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "document_chunks" in tables:
                rewrite_vector_paths(
                    target,
                    source_root.parent,
                    target_root.parent,
                    legacy_roots=(
                        source_root.parent.with_name("com.xincmm.sageread"),
                        source_root.parent.with_name("com.xincmm.sageread.dev"),
                    ),
                )
        elif source.name == "metadata.json":
            copy_metadata_file(source, target, source_root.parent, target_root.parent)
        else:
            shutil.copy2(source, target)
        copied["files"] += 1
        copied["bytes"] += source.stat().st_size
    return copied


def copy_raw_tree(source_root, target_root):
    if not source_root.exists():
        return
    if source_root.is_symlink():
        raise ValueError(f"备份目录不允许符号链接: {source_root}")
    if source_root.is_file():
        target_root.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_root, target_root)
        return
    for source in source_root.rglob("*"):
        if source.is_symlink():
            raise ValueError(f"备份目录不允许符号链接: {source}")
        if source.is_file():
            target = target_root / source.relative_to(source_root)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)


def table_names(db, schema="main"):
    return {
        row[0]
        for row in db.execute(f"SELECT name FROM {schema}.sqlite_master WHERE type='table'")
        if not row[0].startswith("sqlite_") and row[0] not in SKIP_TABLES and not row[0].startswith("_sqlx")
    }


def columns(db, table, schema="main"):
    escaped = table.replace('"', '""')
    return [row[1] for row in db.execute(f'PRAGMA {schema}.table_info("{escaped}")')]


def merge_databases(source, target):
    target_db = sqlite3.connect(target)
    inserted = {}
    try:
        target_db.execute("PRAGMA foreign_keys=OFF")
        target_db.execute("ATTACH DATABASE ? AS source_db", (str(Path(source).resolve()),))
        target_db.execute("BEGIN IMMEDIATE")
        for table in sorted(table_names(target_db) & table_names(target_db, "source_db")):
            shared = [column for column in columns(target_db, table) if column in columns(target_db, table, "source_db")]
            if not shared:
                continue
            escaped_table = table.replace('"', '""')
            fields = ",".join(f'"{column}"' for column in shared)
            cursor = target_db.execute(
                f'INSERT OR IGNORE INTO "{escaped_table}" ({fields}) SELECT {fields} FROM source_db."{escaped_table}"'
            )
            inserted[table] = max(0, cursor.rowcount)
        violations = target_db.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            raise ValueError(f"合并后外键检查失败: {violations[:3]}")
        target_db.commit()
        target_db.execute("PRAGMA foreign_keys=ON")
        check_integrity(target_db)
    except Exception:
        target_db.rollback()
        raise
    finally:
        target_db.close()
    return inserted


def database_counts(path):
    with managed_sqlite(open_readonly(path)) as db:
        tables = table_names(db)
        result = {table: db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0] for table in ("books", "threads") if table in tables}
        result["formats"] = dict(db.execute("SELECT format,count(*) FROM books GROUP BY format").fetchall()) if "books" in tables else {}
        return result


def backup_inputs(source, target, backup_root):
    snapshot_sqlite(source / "database" / "app.db", backup_root / "source-app.db")
    snapshot_sqlite(target / "database" / "app.db", backup_root / "target-app.db")
    for name in CONFIG_FILES:
        path = source / name
        if path.is_file():
            copy_raw_tree(path, backup_root / "source-config" / name)
    original_configs = {name for name in CONFIG_FILES if (target / name).is_file()}
    for name in original_configs:
        copy_raw_tree(target / name, backup_root / "target-config" / name)
    original_assets = set()
    for name in (*ASSET_DIRS, "agent-workspace"):
        if (target / name).exists():
            original_assets.add(name)
            copy_raw_tree(target / name, backup_root / "target-assets" / name)
    return original_configs, original_assets


def restore_inputs(target, backup_root, original_configs, original_assets):
    snapshot_sqlite(backup_root / "target-app.db", target / "database" / "app.db")
    checkpoint_sqlite(target / "database" / "app.db")
    for name in CONFIG_FILES:
        backup = backup_root / "target-config" / name
        if name in original_configs and backup.exists():
            copy_raw_tree(backup, target / name)
        else:
            (target / name).unlink(missing_ok=True)
    for name in (*ASSET_DIRS, "agent-workspace"):
        if name in original_assets:
            shutil.rmtree(target / name, ignore_errors=True)
            copy_raw_tree(backup_root / "target-assets" / name, target / name)
        elif (target / name).exists():
            shutil.rmtree(target / name)


def verify_assets(source, target):
    verified = []
    for name in ("books", "papers"):
        for vector in (target / name).rglob("vectors.sqlite") if (target / name).exists() else []:
            with managed_sqlite(sqlite3.connect(vector)) as db:
                tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if "document_chunks" not in tables:
                    continue
                count = db.execute("SELECT count(*) FROM document_chunks").fetchone()[0]
                paths = [row[0] for row in db.execute("SELECT DISTINCT md_file_path FROM document_chunks")]
                for value in paths:
                    candidate = Path(value) if ntpath.isabs(value) else target / value
                    if not candidate.is_file():
                        raise ValueError(f"向量索引指向缺失文件: {candidate}")
                source_vector = source / vector.relative_to(target)
                with managed_sqlite(open_readonly(source_vector)) as source_db:
                    source_count = source_db.execute("SELECT count(*) FROM document_chunks").fetchone()[0]
                if source_count != count:
                    raise ValueError(f"向量分片数量不一致: {vector.name}")
                verified.append({"file": str(vector.relative_to(target)), "chunks": count})
    return verified


def prepare_preview_copy(source, target, backup_root, apply=False, confirm_stopped=False):
    source = Path(source)
    target = Path(target)
    backup_root = Path(backup_root)
    if not (source / "database" / "app.db").is_file() or not (target / "database" / "app.db").is_file():
        raise FileNotFoundError("源和目标都必须有 database/app.db")
    if apply and not confirm_stopped:
        raise ValueError("复制前必须关闭 Preview 应用进程；仅 Vite 可以保持运行")
    manifest = {
        "apply": apply,
        "source": database_counts(source / "database" / "app.db"),
        "target_before": database_counts(target / "database" / "app.db"),
        "source_books": database_counts(source / "database" / "app.db").get("books", 0),
        "configs": list(CONFIG_FILES),
        "excluded": ["papers-converter", "sync-state.json", "secrets-fallback.json", "agent-audit", "sync-staging", "agent-workspace 源目录"],
        "verified": False,
    }
    if not apply:
        return manifest
    if backup_root.exists() and any(backup_root.iterdir()):
        raise FileExistsError("备份目录必须为空，重试时请使用新目录，避免覆盖首次回滚基线")
    original_configs, original_assets = backup_inputs(source, target, backup_root)
    redacted = 0
    try:
        copied = {}
        for name in ASSET_DIRS:
            copied[name] = copy_asset_tree(source / name, target / name)
        manifest["merged_rows"] = merge_databases(source / "database" / "app.db", target / "database" / "app.db")
        with managed_sqlite(sqlite3.connect(target / "database" / "app.db")) as db:
            for book_id, file_path, cover_path in db.execute("SELECT id,file_path,cover_path FROM books").fetchall():
                legacy_roots = (
                    source.with_name("com.xincmm.sageread"),
                    source.with_name("com.xincmm.sageread.dev"),
                )
                mapped = remap_path(file_path, source, target, legacy_roots)
                mapped_cover = remap_path(cover_path, source, target, legacy_roots)
                if mapped != file_path or mapped_cover != cover_path:
                    db.execute("UPDATE books SET file_path=?,cover_path=? WHERE id=?", (mapped, mapped_cover, book_id))
            db.commit()
            if db.execute("PRAGMA foreign_key_check").fetchall():
                raise ValueError("路径映射后外键检查失败")
        for name in CONFIG_FILES:
            path = source / name
            if not path.is_file():
                continue
            data = read_json(path)
            if name == "agent-settings.json":
                existing = read_json(target / name) if (target / name).is_file() else None
                data = remap_agent_settings(data, target, existing)
            cleaned, count = sanitize_config(data)
            redacted += count
            write_json(target / name, cleaned)
        manifest["redacted_config_values"] = redacted
        manifest["assets"] = copied
        manifest["vectors"] = verify_assets(source, target)
        manifest["target_after"] = database_counts(target / "database" / "app.db")
        if manifest["target_after"].get("books", 0) < manifest["source_books"]:
            raise ValueError("合并后的书籍数量少于来源数量")
        manifest["verified"] = True
        manifest["backup_root"] = str(backup_root)
        write_json(backup_root / "manifest.json", manifest)
        return manifest
    except Exception:
        restore_inputs(target, backup_root, original_configs, original_assets)
        raise


def main():
    parser = argparse.ArgumentParser(description="制作一次性 Preview 数据副本；默认只审计，不写入")
    parser.add_argument("--source", type=Path, default=Path.home() / "AppData/Roaming/com.bettersageread.dev")
    parser.add_argument("--target", type=Path, default=Path.home() / "AppData/Roaming/com.bettersageread.preview")
    parser.add_argument("--backup-root", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm-stopped", action="store_true")
    args = parser.parse_args()
    backup = args.backup_root or Path.cwd() / ".tmp-workspace-demo" / "data-backups" / datetime.now().strftime("%Y%m%d-%H%M%S")
    manifest = prepare_preview_copy(args.source, args.target, backup, args.apply, args.confirm_stopped)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
