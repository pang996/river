# -*- coding: utf-8 -*-
"""全量同步：原库 -> 本地测试副本（semester/subject/course/grad_requirement）
- subject 表结构补齐 assessment_method / course_type
- 覆盖 semester / subject / course 数据（保留 id）
- grad_requirement 清空重灌（原库为准）
- 副本设置当前学期（2026秋 id=2）为 is_current=1
- 修正 id=18 心理健康 weeks 9016 -> 9-16
"""
import sqlite3

SRC = r"C:\Users\pangq\WorkBuddy\2026-08-29-13-01-36\course-reminder\course.db"
DST = r"C:\Users\pangq\Doubao\chats\2026-09-03\new-chat\course_local\data\course.db"

src = sqlite3.connect(SRC)
dst = sqlite3.connect(DST)


def ensure_col(db, table, col, ddl):
    cols = [r[1] for r in db.execute(f"PRAGMA table_info({table})")]
    if col not in cols:
        db.execute(ddl)


# 1. 补列（新字段）
ensure_col(dst, "subject", "assessment_method", "ALTER TABLE subject ADD COLUMN assessment_method TEXT")
ensure_col(dst, "subject", "course_type", "ALTER TABLE subject ADD COLUMN course_type TEXT")
ensure_col(dst, "subject", "medal_img", "ALTER TABLE subject ADD COLUMN medal_img TEXT")
ensure_col(dst, "event", "period", "ALTER TABLE event ADD COLUMN period TEXT DEFAULT ''")
ensure_col(dst, "grad_requirement", "medal_img", "ALTER TABLE grad_requirement ADD COLUMN medal_img TEXT")
dst.commit()

# 2. 全量覆盖 semester
dst.execute("DELETE FROM semester")
rows = src.execute("SELECT * FROM semester ORDER BY id").fetchall()
cols = [d[0] for d in src.execute("SELECT * FROM semester LIMIT 1").description]
dst.executemany(f"INSERT INTO semester ({','.join(cols)}) VALUES ({','.join(['?']*len(cols))})", rows)
print(f"semester 同步 {len(rows)} 条")

# 3. 全量覆盖 subject
dst.execute("DELETE FROM subject")
rows = src.execute("SELECT * FROM subject ORDER BY id").fetchall()
cols = [d[0] for d in src.execute("SELECT * FROM subject LIMIT 1").description]
dst.executemany(f"INSERT INTO subject ({','.join(cols)}) VALUES ({','.join(['?']*len(cols))})", rows)
print(f"subject 同步 {len(rows)} 条（含 assessment_method/course_type）")

# 4. 全量覆盖 course
dst.execute("DELETE FROM course")
rows = src.execute("SELECT * FROM course ORDER BY id").fetchall()
cols = [d[0] for d in src.execute("SELECT * FROM course LIMIT 1").description]
dst.executemany(f"INSERT INTO course ({','.join(cols)}) VALUES ({','.join(['?']*len(cols))})", rows)
print(f"course 同步 {len(rows)} 条")

# 5. grad_requirement 清空重灌（含 medal_img）
dst.execute("DELETE FROM grad_requirement")
rows = src.execute(
    "SELECT id, category, required_credits, obtained_credits, note, created_at, updated_at, kind, done, COALESCE(medal_img,'') "
    "FROM grad_requirement ORDER BY id").fetchall()
for r in rows:
    dst.execute(
        "INSERT INTO grad_requirement (id, category, required_credits, obtained_credits, note, created_at, updated_at, kind, done, medal_img) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)", r)
print(f"grad_requirement 同步 {len(rows)} 条（含 medal_img）")

# 6. 副本设置当前学期（2026秋 id=2）
dst.execute("UPDATE semester SET is_current=0")
dst.execute("UPDATE semester SET is_current=1 WHERE id=2")
print("副本当前学期: 2026秋大一上(id=2) is_current=1")

# 7. 修正心理健康 weeks
dst.execute("UPDATE course SET weeks='9-16' WHERE id=18 AND weeks='9016'")
print("修正 id=18 心理健康 weeks=9-16")

dst.commit()
dst.close()
src.close()
print("=== 全量同步完成 ===")
