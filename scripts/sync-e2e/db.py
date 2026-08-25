# db.py —— E2E SQL 助手（stdlib sqlite3，只读查询可直连运行中的 WAL 库；写操作请先停实例）
# 用法:
#   python db.py threads <A|B>                列出对话 id/starred/updated_at
#   python db.py star-check <B> <thread_id>   查某对话 starred（soak 断言）
#   python db.py p5-setup <A|B> <book_id>     停实例后注入 book_status 测试行
#   python db.py p5-check <A> <book_id>       查 book_status 行（P5 断言）
#   python db.py books <A|B>                  列出书 id/title
import json
import sqlite3
import sys
import time

DIRS = {
    "A": r"C:/Users/20995/AppData/Roaming/com.bettersageread.dev2",
    "B": r"C:/Users/20995/AppData/Roaming/com.bettersageread.dev3",
}


def conn(who):
    db = sqlite3.connect(f"file:{DIRS[who]}/database/app.db?mode=ro", uri=True)
    return db


def conn_rw(who):
    return sqlite3.connect(f"{DIRS[who]}/database/app.db", timeout=30)


def main():
    cmd = sys.argv[1]
    if cmd == "threads":
        db = conn(sys.argv[2])
        for r in db.execute("SELECT id, starred, updated_at, substr(title,1,30) FROM threads ORDER BY updated_at DESC LIMIT 15"):
            print(r)
    elif cmd == "star-check":
        db = conn(sys.argv[2])
        row = db.execute("SELECT starred, updated_at FROM threads WHERE id=?", (sys.argv[3],)).fetchone()
        print(json.dumps({"starred": row[0], "updated_at": row[1]} if row else None))
    elif cmd == "books":
        db = conn(sys.argv[2])
        n = db.execute("SELECT COUNT(*) FROM books").fetchone()[0]
        print(f"count={n}")
        for r in db.execute("SELECT id, substr(title,1,40) FROM books LIMIT 8"):
            print(r)
    elif cmd == "p5-setup":
        who, book_id = sys.argv[2], sys.argv[3]
        now = int(time.time() * 1000)
        db = conn_rw(who)
        if who == "A":
            # 本地真进度：position_changed_at=2000, location='cfi-real'（updated_at 给当前，触发器落日志后由调用方清理）
            db.execute(
                "INSERT INTO book_status (book_id, status, progress_current, progress_total, location, last_read_at, position_changed_at, dwell_seconds, created_at, updated_at)"
                " VALUES (?, 'reading', 50, 100, 'cfi-real', 3000, 2000, 60, 1000, ?)"
                " ON CONFLICT(book_id) DO UPDATE SET location='cfi-real', position_changed_at=2000, last_read_at=3000, progress_current=50, updated_at=?",
                (book_id, now, now),
            )
            # A 的行不推送（清理日志，只保留本地状态）——我们要验证的是 B→A 方向
            db.execute("DELETE FROM _sync_log WHERE table_name='book_status' AND row_id=?", (book_id,))
        else:
            # B：只打开未翻页——position_changed_at=NULL，last_read_at 更大，location='cfi-open-only'，updated_at 新（触发推送）
            db.execute(
                "INSERT INTO book_status (book_id, status, progress_current, progress_total, location, last_read_at, position_changed_at, dwell_seconds, created_at, updated_at)"
                " VALUES (?, 'reading', 0, 100, 'cfi-open-only', ?, NULL, 0, 1000, ?)"
                " ON CONFLICT(book_id) DO UPDATE SET location='cfi-open-only', position_changed_at=NULL, last_read_at=?, updated_at=?",
                (book_id, now, now, now, now),
            )
        db.commit()
        row = db.execute(
            "SELECT location, last_read_at, position_changed_at, updated_at FROM book_status WHERE book_id=?",
            (book_id,),
        ).fetchone()
        pending = db.execute("SELECT COUNT(*) FROM _sync_log WHERE table_name='book_status' AND row_id=?", (book_id,)).fetchone()[0]
        db.close()
        print(json.dumps({"row": row, "pending_sync_log": pending}))
    elif cmd == "p5-check":
        db = conn(sys.argv[2])
        row = db.execute(
            "SELECT location, last_read_at, position_changed_at, updated_at FROM book_status WHERE book_id=?",
            (sys.argv[3],),
        ).fetchone()
        print(json.dumps({"location": row[0], "last_read_at": row[1], "position_changed_at": row[2], "updated_at": row[3]} if row else None))
    elif cmd == "sync-log-count":
        db = conn(sys.argv[2])
        print(db.execute("SELECT COALESCE(MAX(seq),0) FROM _sync_log").fetchone()[0])
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
