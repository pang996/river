# -*- coding: utf-8 -*-
"""
course-reminder 本地测试平台 · Flask 后端
基于用户现有 course.db（SQLite）的字段、结构与数据搭建，
先本地验证功能，验证通过后再对接云端部署。
"""
import os
import sqlite3
from datetime import datetime, date

from flask import Flask, g, request, jsonify, send_from_directory, session
from werkzeug.security import generate_password_hash, check_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data", "course.db")
STATIC_DIR = os.path.join(BASE_DIR, "static")
MAX_WEEK = 30  # 学期最大周数

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="")
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-change-me-in-prod")
app.config["SESSION_COOKIE_NAME"] = "course_sid"
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["PERMANENT_SESSION_LIFETIME"] = 60 * 60 * 12  # 会话 12 小时


@app.after_request
def no_store(resp):
    """本地开发禁用缓存，确保前端改动即时生效"""
    resp.headers["Cache-Control"] = "no-store"
    return resp


# ---------------- 数据库连接 ----------------

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


# ---------------- 账号鉴权 ----------------

def init_users():
    """确保 users 表存在；首次运行创建默认账号 admin / admin123（部署后请修改）"""
    db = sqlite3.connect(DB_PATH)
    db.execute("CREATE TABLE IF NOT EXISTS users ("
               "id INTEGER PRIMARY KEY AUTOINCREMENT,"
               "username TEXT UNIQUE NOT NULL,"
               "password_hash TEXT NOT NULL,"
               "created_at TEXT DEFAULT (datetime('now')))")
    if not db.execute("SELECT 1 FROM users").fetchone():
        db.execute("INSERT INTO users (username, password_hash) VALUES (?, ?)",
                   ("admin", generate_password_hash("admin123")))
        db.commit()
    db.close()


init_users()


@app.before_request
def auth_guard():
    """所有 /api/* 接口（除登录）必须登录，未登录返回 401"""
    if request.path.startswith("/api/") and request.path != "/api/login":
        if not session.get("uid"):
            return jsonify({"error": "未登录"}), 401


@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    if row and check_password_hash(row["password_hash"], password):
        session.clear()
        session["uid"] = row["id"]
        session["username"] = row["username"]
        return jsonify({"ok": True, "username": row["username"]})
    return jsonify({"error": "账号或密码错误"}), 401


@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/me")
def api_me():
    if session.get("uid"):
        return jsonify({"ok": True, "username": session.get("username")})
    return jsonify({"error": "未登录"}), 401


@app.route("/api/password", methods=["POST"])
def api_password():
    if not session.get("uid"):
        return jsonify({"error": "未登录"}), 401
    data = request.get_json(silent=True) or {}
    old = data.get("old") or ""
    new = data.get("new") or ""
    if len(new) < 6:
        return jsonify({"error": "新密码至少 6 位"}), 400
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE id=?", (session["uid"],)).fetchone()
    if not row or not check_password_hash(row["password_hash"], old):
        return jsonify({"error": "原密码错误"}), 400
    db.execute("UPDATE users SET password_hash=? WHERE id=?",
               (generate_password_hash(new), session["uid"]))
    db.commit()
    return jsonify({"ok": True})


def rows_to_list(rows):
    return [dict(r) for r in rows]


# ---------------- 周次解析（核心逻辑） ----------------

def parse_weeks(s, max_week=MAX_WEEK):
    """
    将 course.weeks 字段解析为周数集合。
    支持格式：
      'all'        -> 全部周
      '4-9'        -> 4~9 周（区间）
      '5,7,8'      -> 第 5、7、8 周（离散）
      '6'          -> 第 6 周（单周）
    返回 set[int]
    """
    s = (s or "").strip().lower()
    weeks = set()
    if not s or s == "all":
        return set(range(1, max_week + 1))
    for part in s.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            try:
                weeks.update(range(int(a), int(b) + 1))
            except ValueError:
                continue
        else:
            try:
                weeks.add(int(part))
            except ValueError:
                continue
    return weeks


def week_in_course(weeks_field, week_num):
    return week_num in parse_weeks(weeks_field)


# ---------------- 工具函数 ----------------

def get_current_semester():
    db = get_db()
    row = db.execute(
        "SELECT * FROM semester WHERE is_current=1 ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if row:
        return dict(row)
    # 兜底1：已开始的学期中取开始日期最晚的（即当前正在进行）
    today = date.today().isoformat()
    row = db.execute(
        "SELECT * FROM semester WHERE start_date <= ? ORDER BY start_date DESC LIMIT 1",
        (today,),
    ).fetchone()
    if row:
        return dict(row)
    # 兜底2：都还没开始，取开始日期最早的
    row = db.execute("SELECT * FROM semester ORDER BY start_date ASC LIMIT 1").fetchone()
    return dict(row) if row else None


def calc_week_of_semester(semester_start, today=None):
    """
    根据学期开始日期，计算今天是第几周（周一为一周起点）。
    semester_start: 'YYYY-MM-DD'
    """
    try:
        start = date.fromisoformat(semester_start)
    except (ValueError, TypeError):
        return 1
    today = today or date.today()
    diff = (today - start).days
    if diff < 0:
        return 1
    return diff // 7 + 1


# ---------------- 页面 ----------------

@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


# ---------------- API：概览 ----------------

@app.route("/api/overview")
def api_overview():
    db = get_db()
    courses = db.execute("SELECT COUNT(*) c FROM course").fetchone()["c"]
    events = db.execute("SELECT COUNT(*) c FROM event").fetchone()["c"]
    subjects = db.execute("SELECT COUNT(*) c FROM subject").fetchone()["c"]
    semesters = db.execute("SELECT COUNT(*) c FROM semester").fetchone()["c"]
    cur = get_current_semester()
    today_week = calc_week_of_semester(cur["start_date"]) if cur else 1
    return jsonify({
        "db_file": os.path.basename(DB_PATH),
        "db_size": os.path.getsize(DB_PATH),
        "courses": courses,
        "events": events,
        "subjects": subjects,
        "semesters": semesters,
        "current_semester": cur,
        "today": date.today().isoformat(),
        "today_week": today_week,
        "max_week": MAX_WEEK,
    })


# ---------------- API：学期 ----------------

@app.route("/api/semesters")
def api_semesters():
    db = get_db()
    rows = db.execute("SELECT * FROM semester ORDER BY sort_order, id").fetchall()
    return jsonify(rows_to_list(rows))


@app.route("/api/semesters/reorder", methods=["POST"])
def api_semesters_reorder():
    db = get_db()
    data = request.get_json(silent=True) or {}
    ids = data.get("ids") or []
    for i, sid in enumerate(ids):
        db.execute("UPDATE semester SET sort_order=? WHERE id=?", (i, sid))
    db.commit()
    return jsonify({"ok": True, "count": len(ids)})


@app.route("/api/subjects/reorder", methods=["POST"])
def api_subjects_reorder():
    db = get_db()
    data = request.get_json(silent=True) or {}
    ids = data.get("ids") or []
    for i, sid in enumerate(ids):
        db.execute("UPDATE subject SET sort_order=? WHERE id=?", (i, sid))
    db.commit()
    return jsonify({"ok": True, "count": len(ids)})


@app.route("/api/semesters", methods=["POST"])
def api_semester_create():
    db = get_db()
    data = request.get_json(silent=True) or {}
    if not data.get("name") or not data.get("start_date"):
        return jsonify({"error": "缺少学期名或开始日期"}), 400
    cur = db.execute(
        "INSERT INTO semester (name, start_date, scale, is_current, sort_order, updated_at) "
        "VALUES (?,?,?,?,?,?)",
        (data["name"], data["start_date"], data.get("scale") or "4.0",
         int(data.get("is_current") or 0),
         db.execute("SELECT COALESCE(MAX(sort_order),-1)+1 FROM semester").fetchone()[0],
         datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
    )
    db.commit()
    row = db.execute("SELECT * FROM semester WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/api/semesters/<int:sid>", methods=["PATCH"])
def api_semester_update(sid):
    db = get_db()
    row = db.execute("SELECT * FROM semester WHERE id=?", (sid,)).fetchone()
    if not row:
        return jsonify({"error": "学期不存在"}), 404
    data = request.get_json(silent=True) or {}
    allow = {"name", "start_date", "scale", "is_current"}
    sets, vals = [], []
    for k, v in data.items():
        if k in allow:
            sets.append(f"{k}=?")
            vals.append(v)
    if not sets:
        return jsonify({"error": "无有效字段"}), 400
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    # 设为当前时，先把其他学期置 0（保持唯一）
    if int(data.get("is_current") or 0) == 1:
        db.execute("UPDATE semester SET is_current=0, updated_at=? WHERE is_current=1", (now,))
    vals.append(now)
    db.execute(f"UPDATE semester SET {', '.join(sets)}, updated_at=? WHERE id=?",
               vals + [sid])
    db.commit()
    row = db.execute("SELECT * FROM semester WHERE id=?", (sid,)).fetchone()
    return jsonify(dict(row))


@app.route("/api/semesters/<int:sid>/current", methods=["POST"])
def api_semester_set_current(sid):
    """把指定学期设为当前学期（其余置 0）"""
    db = get_db()
    row = db.execute("SELECT * FROM semester WHERE id=?", (sid,)).fetchone()
    if not row:
        return jsonify({"error": "学期不存在"}), 404
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    db.execute("UPDATE semester SET is_current=0, updated_at=? WHERE is_current=1", (now,))
    db.execute("UPDATE semester SET is_current=1, updated_at=? WHERE id=?", (now, sid))
    db.commit()
    return jsonify({"ok": True, "id": sid})


@app.route("/api/semesters/<int:sid>", methods=["DELETE"])
def api_semester_delete(sid):
    """删除学期，并级联删除其下课程、科目、成绩"""
    db = get_db()
    row = db.execute("SELECT * FROM semester WHERE id=?", (sid,)).fetchone()
    if not row:
        return jsonify({"error": "学期不存在"}), 404
    # 该学期下科目的成绩
    db.execute(
        "DELETE FROM grade WHERE subject_id IN "
        "(SELECT id FROM subject WHERE semester_id=?)", (sid,))
    # 该学期下科目
    db.execute("DELETE FROM subject WHERE semester_id=?", (sid,))
    # 该学期下课程
    db.execute("DELETE FROM course WHERE semester_id=?", (sid,))
    db.execute("DELETE FROM semester WHERE id=?", (sid,))
    db.commit()
    return jsonify({"ok": True})


# ---------------- API：课程 ----------------

def course_full(row):
    d = dict(row)
    d["weeks_set"] = sorted(parse_weeks(d.get("weeks")))
    return d


@app.route("/api/courses")
def api_courses():
    db = get_db()
    semester_id = request.args.get("semester_id", type=int)
    q = "SELECT c.*, s.name AS subject_name FROM course c LEFT JOIN subject s ON c.subject_id=s.id"
    params = []
    if semester_id:
        q += " WHERE c.semester_id=?"
        params.append(semester_id)
    q += " ORDER BY c.day_of_week, c.period_start"
    rows = db.execute(q, params).fetchall()
    return jsonify([course_full(r) for r in rows])


@app.route("/api/schedule_month")
def api_schedule_month():
    """按月返回该月每天的课程 + 事件 + 假期，供月历视图使用"""
    import calendar
    db = get_db()
    semester_id = request.args.get("semester_id", type=int)
    month = request.args.get("month") or date.today().strftime("%Y-%m")
    try:
        y, m = map(int, month.split("-"))
    except (ValueError, AttributeError):
        return jsonify({"error": "month 需为 YYYY-MM"}), 400
    ndays = calendar.monthrange(y, m)[1]

    if not semester_id:
        cur = db.execute("SELECT id FROM semester WHERE is_current=1").fetchone()
        semester_id = cur["id"] if cur else None
    sem_start = None
    if semester_id:
        sr = db.execute("SELECT start_date FROM semester WHERE id=?", (semester_id,)).fetchone()
        sem_start = sr["start_date"] if sr else None

    # 课程按天归类
    courses = {}
    if sem_start:
        rows = db.execute(
            "SELECT c.*, s.name AS subject_name FROM course c "
            "LEFT JOIN subject s ON c.subject_id=s.id WHERE c.semester_id=?", (semester_id,)).fetchall()
        for r in rows:
            d = dict(r)
            wset = parse_weeks(d.get("weeks"))
            if not wset:
                continue
            for day in range(1, ndays + 1):
                d_obj = date(y, m, day)
                wk = calc_week_of_semester(sem_start, d_obj)
                if wk in wset and d_obj.isoweekday() == (d.get("day_of_week") or 0):
                    courses.setdefault(day, []).append(d)

    # 事件按天归类
    events = {}
    for e in db.execute(
            "SELECT * FROM event WHERE substr(ev_date,1,7)=? ORDER BY ev_date, time", (month,)):
        d = dict(e)
        events.setdefault(int(d["ev_date"][8:10]), []).append(d)

    # 假期按天归类
    holidays = {}
    for h in db.execute(
            "SELECT * FROM custom_holiday WHERE substr(date,1,7)=? ORDER BY date", (month,)):
        d = dict(h)
        holidays.setdefault(int(d["date"][8:10]), []).append(d)

    sem_name = None
    if semester_id:
        rn = db.execute("SELECT name FROM semester WHERE id=?", (semester_id,)).fetchone()
        if rn:
            sem_name = rn["name"]

    return jsonify({
        "month": month,
        "year": y, "month_num": m, "ndays": ndays,
        "semester_id": semester_id,
        "semester_name": sem_name,
        "courses": courses, "events": events, "holidays": holidays,
    })


@app.route("/api/schedule")
def api_schedule():
    """按学期 + 周次返回周历数据（只返回该周有课的课程）"""
    db = get_db()
    semester_id = request.args.get("semester_id", type=int)
    week = request.args.get("week", type=int, default=1)
    q = ("SELECT c.*, s.name AS subject_name FROM course c "
         "LEFT JOIN subject s ON c.subject_id=s.id")
    params = []
    if semester_id:
        q += " WHERE c.semester_id=?"
        params.append(semester_id)
    rows = db.execute(q, params).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["weeks_set"] = sorted(parse_weeks(d.get("weeks")))
        d["in_week"] = week_in_course(d.get("weeks"), week)
        if d["in_week"]:
            result.append(d)
    result.sort(key=lambda x: (x["day_of_week"], x["period_start"]))
    return jsonify(result)


@app.route("/api/courses/<int:cid>/weeks")
def api_course_weeks(cid):
    """返回某门课展开后的周数列表（录一条 -> 展开多周）"""
    db = get_db()
    row = db.execute("SELECT * FROM course WHERE id=?", (cid,)).fetchone()
    if not row:
        return jsonify({"error": "课程不存在"}), 404
    d = dict(row)
    weeks = parse_weeks(d.get("weeks"))
    return jsonify({
        "id": cid,
        "name": d["name"],
        "weeks_text": d.get("weeks"),
        "expanded_weeks": sorted(weeks),
        "count": len(weeks),
    })


@app.route("/api/courses", methods=["POST"])
def api_course_create():
    db = get_db()
    data = request.get_json(silent=True) or {}
    fields = ["semester_id", "name", "location", "day_of_week", "weeks",
              "credit", "memo", "period_start", "period_end",
              "start_time", "end_time", "subject_id"]
    if not data.get("name") or not data.get("semester_id"):
        return jsonify({"error": "缺少课程名或学期"}), 400
    cols = ", ".join(fields)
    marks = ", ".join(["?"] * len(fields))
    vals = [data.get(f) for f in fields]
    cur = db.execute(
        f"INSERT INTO course ({cols}, updated_at) VALUES ({marks}, ?)",
        vals + [datetime.now().strftime("%Y-%m-%d %H:%M:%S")],
    )
    db.commit()
    row = db.execute("SELECT * FROM course WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify(course_full(row)), 201


@app.route("/api/courses/<int:cid>", methods=["PATCH"])
def api_course_update(cid):
    db = get_db()
    row = db.execute("SELECT * FROM course WHERE id=?", (cid,)).fetchone()
    if not row:
        return jsonify({"error": "课程不存在"}), 404
    data = request.get_json(silent=True) or {}
    allow = {"semester_id", "name", "location", "day_of_week", "weeks",
             "credit", "memo", "period_start", "period_end",
             "start_time", "end_time", "subject_id"}
    sets, vals = [], []
    for k, v in data.items():
        if k in allow:
            sets.append(f"{k}=?")
            vals.append(v)
    if not sets:
        return jsonify({"error": "无有效字段"}), 400
    vals.append(datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    db.execute(f"UPDATE course SET {', '.join(sets)}, updated_at=? WHERE id=?",
               vals + [cid])
    db.commit()
    row = db.execute("SELECT * FROM course WHERE id=?", (cid,)).fetchone()
    return jsonify(course_full(row))


@app.route("/api/courses/<int:cid>", methods=["DELETE"])
def api_course_delete(cid):
    db = get_db()
    db.execute("DELETE FROM course WHERE id=?", (cid,))
    db.commit()
    return jsonify({"ok": True})


# ---------------- API：事件日程 ----------------

@app.route("/api/events")
def api_events():
    db = get_db()
    rows = db.execute("SELECT * FROM event ORDER BY ev_date, time").fetchall()
    return jsonify(rows_to_list(rows))


@app.route("/api/events", methods=["POST"])
def api_event_create():
    db = get_db()
    data = request.get_json(silent=True) or {}
    if not data.get("ev_date") or not data.get("title"):
        return jsonify({"error": "缺少日期或标题"}), 400
    cur = db.execute(
        "INSERT INTO event (ev_date, title, location, note, time, period, updated_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (data["ev_date"], data["title"], data.get("location", ""),
         data.get("note", ""), data.get("time", ""), data.get("period", ""),
         datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
    )
    db.commit()
    row = db.execute("SELECT * FROM event WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/api/events/<int:eid>", methods=["DELETE"])
def api_event_delete(eid):
    db = get_db()
    db.execute("DELETE FROM event WHERE id=?", (eid,))
    db.commit()
    return jsonify({"ok": True})


# ---------------- API：科目与成绩 ----------------

@app.route("/api/subjects")
def api_subjects():
    db = get_db()
    rows = db.execute(
        "SELECT su.*, se.name AS semester_name FROM subject su "
        "LEFT JOIN semester se ON su.semester_id=se.id "
        "ORDER BY su.semester_id, su.sort_order, su.id"
    ).fetchall()
    return jsonify(rows_to_list(rows))


@app.route("/api/badges")
def api_badges():
    """课程徽章列表（玻璃拟态 PNG），含科目关联信息"""
    db = get_db()
    rows = db.execute(
        "SELECT b.id, b.name, b.filename, b.subject_id, b.sort_order, "
        "s.name AS subject_name "
        "FROM badge b LEFT JOIN subject s ON b.subject_id=s.id "
        "ORDER BY b.sort_order, b.id"
    ).fetchall()
    return jsonify(rows_to_list(rows))


@app.route("/api/subjects", methods=["POST"])
def api_subject_create():
    db = get_db()
    data = request.get_json(silent=True) or {}
    if not data.get("name") or not data.get("semester_id"):
        return jsonify({"error": "缺少科目名或学期"}), 400
    cur = db.execute(
        "INSERT INTO subject (semester_id, name, credit, location, grad_category, assessment_method, course_type, medal_img, sort_order, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (data["semester_id"], data["name"], data.get("credit") or 0,
         data.get("location", ""), data.get("grad_category", ""),
         data.get("assessment_method", ""), data.get("course_type", ""),
         data.get("medal_img", ""),
         (db.execute("SELECT COALESCE(MAX(sort_order),-1)+1 FROM subject WHERE semester_id=?", (data["semester_id"],)).fetchone()[0]),
         datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
    )
    db.commit()
    row = db.execute("SELECT * FROM subject WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/api/subjects/<int:sid>", methods=["PATCH"])
def api_subject_update(sid):
    db = get_db()
    row = db.execute("SELECT * FROM subject WHERE id=?", (sid,)).fetchone()
    if not row:
        return jsonify({"error": "科目不存在"}), 404
    data = request.get_json(silent=True) or {}
    allow = {"semester_id", "name", "credit", "location", "grad_category",
             "assessment_method", "course_type", "medal_img"}
    sets, vals = [], []
    for k, v in data.items():
        if k in allow:
            sets.append(f"{k}=?")
            vals.append(v)
    if not sets:
        return jsonify({"error": "无有效字段"}), 400
    vals.append(datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    db.execute(f"UPDATE subject SET {', '.join(sets)}, updated_at=? WHERE id=?",
               vals + [sid])
    db.commit()
    row = db.execute("SELECT * FROM subject WHERE id=?", (sid,)).fetchone()
    return jsonify(dict(row))


@app.route("/api/subjects/batch", methods=["POST"])
def api_subject_batch():
    """批量导入科目：items = [{name, semester_id, credit, location, grad_category}, ...]"""
    db = get_db()
    data = request.get_json(silent=True) or {}
    items = data.get("items") or []
    if not items:
        return jsonify({"error": "无科目数据"}), 400
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    ok_ids, fails = [], []
    for i, it in enumerate(items):
        name = (it.get("name") or "").strip()
        if not name:
            fails.append({"row": i + 1, "err": "缺少科目名"})
            continue
        try:
            sem_id = int(it.get("semester_id") or 0)
        except (TypeError, ValueError):
            sem_id = 0
        if not sem_id or not db.execute("SELECT 1 FROM semester WHERE id=?", (sem_id,)).fetchone():
            fails.append({"row": i + 1, "err": f"学期无效（{it.get('semester_id')}）"})
            continue
        cur = db.execute(
            "INSERT INTO subject (semester_id, name, credit, location, grad_category, updated_at) "
            "VALUES (?,?,?,?,?,?)",
            (sem_id, name, it.get("credit") or 0, it.get("location") or "",
             it.get("grad_category") or "", now))
        ok_ids.append(cur.lastrowid)
    db.commit()
    return jsonify({"ok": len(ok_ids), "ids": ok_ids, "fail": fails}), (200 if ok_ids else 400)


@app.route("/api/subjects/<int:sid>", methods=["DELETE"])
def api_subject_delete(sid):
    db = get_db()
    # 关联课程置空 subject_id，关联成绩一并删除
    db.execute("UPDATE course SET subject_id=NULL WHERE subject_id=?", (sid,))
    db.execute("DELETE FROM grade WHERE subject_id=?", (sid,))
    db.execute("DELETE FROM subject WHERE id=?", (sid,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/grades")
def api_grades():
    db = get_db()
    rows = db.execute(
        "SELECT gr.*, su.name AS subject_name FROM grade gr "
        "LEFT JOIN subject su ON gr.subject_id=su.id ORDER BY su.id"
    ).fetchall()
    return jsonify(rows_to_list(rows))


@app.route("/api/grades", methods=["POST"])
def api_grade_upsert():
    """录入/更新某科目的成绩（按 subject_id 幂等：已存在则更新）"""
    db = get_db()
    data = request.get_json(silent=True) or {}
    subject_id = data.get("subject_id")
    score = data.get("score")
    if not subject_id or score is None:
        return jsonify({"error": "缺少科目或成绩"}), 400
    sub = db.execute("SELECT id FROM subject WHERE id=?", (subject_id,)).fetchone()
    if not sub:
        return jsonify({"error": "科目不存在"}), 404
    try:
        score = float(score)
    except (TypeError, ValueError):
        return jsonify({"error": "成绩格式错误"}), 400
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    exists = db.execute("SELECT id FROM grade WHERE subject_id=?", (subject_id,)).fetchone()
    if exists:
        db.execute("UPDATE grade SET score=?, updated_at=? WHERE subject_id=?",
                   (score, now, subject_id))
        gid = exists["id"]
    else:
        cur = db.execute(
            "INSERT INTO grade (subject_id, score, updated_at) VALUES (?,?,?)",
            (subject_id, score, now))
        gid = cur.lastrowid
    db.commit()
    row = db.execute("SELECT * FROM grade WHERE id=?", (gid,)).fetchone()
    return jsonify(dict(row)), 200


@app.route("/api/grades/<int:gid>", methods=["DELETE"])
def api_grade_delete(gid):
    db = get_db()
    db.execute("DELETE FROM grade WHERE id=?", (gid,))
    db.commit()
    return jsonify({"ok": True})


# ---------------- API：毕业要求（培养方案达成度） ----------------

@app.route("/api/grad_progress")
def api_grad_progress():
    """毕业进度汇总：四类需求/已完成/已开课（已开课按当前时间计算）"""
    db = get_db()
    today = date.today().isoformat()

    # 四类需求（非 completion）
    reqs = db.execute(
        "SELECT * FROM grad_requirement WHERE kind != 'completion' ORDER BY id"
    ).fetchall()
    cats = []
    for r in reqs:
        d = dict(r)
        cats.append({
            "category": d["category"],
            "required": d.get("required_credits") or 0,
            "obtained": d.get("obtained_credits") or 0,
            "opened": 0.0,
        })

    # 已完成学分：成绩表按科目类别累计（与 grad_requirements 的 auto 同口径）
    auto = {}
    for r in db.execute("""
        SELECT sub.grad_category AS cat, SUM(sub.credit) AS total
        FROM grade g JOIN subject sub ON sub.id = g.subject_id
        WHERE g.score IS NOT NULL AND sub.grad_category IS NOT NULL AND sub.grad_category != ''
        GROUP BY sub.grad_category
    """):
        auto[r["cat"] or ""] = round(r["total"] or 0, 1)
    for c in cats:
        a = 0.0
        for cat, total in auto.items():
            if c["category"] in cat or cat in c["category"]:
                a += total
        c["obtained"] = round(max(c["obtained"], a), 1)

    # 已开课学分：按课程，所属学期已开始 且 该学期当前周 >= 课程开始周
    sems = {s["id"]: dict(s) for s in db.execute("SELECT * FROM semester").fetchall()}
    subjects = {s["id"]: dict(s) for s in db.execute("SELECT * FROM subject").fetchall()}
    total_opened = 0.0
    opened_other = 0.0  # 未归类到四类的开课学分
    for c in db.execute("SELECT * FROM course").fetchall():
        sem = sems.get(c["semester_id"])
        if not sem or sem["start_date"] > today:
            continue  # 学期未开始
        wset = parse_weeks(c["weeks"])
        if not wset:
            continue
        if calc_week_of_semester(sem["start_date"]) < min(wset):
            continue  # 尚未开课
        cr = c["credit"] or 0
        total_opened += cr
        cat = None
        if c["subject_id"]:
            s = subjects.get(c["subject_id"])
            if s:
                cat = s.get("grad_category")
        matched = False
        for c_ in cats:
            if cat and (c_["category"] in cat or cat in c_["category"]):
                c_["opened"] = round(c_["opened"] + cr, 1)
                matched = True
        if not matched:
            opened_other += cr
    total_opened = round(total_opened, 1)

    total_required = round(sum(c["required"] for c in cats), 1)
    total_obtained = round(sum(c["obtained"] for c in cats), 1)
    return jsonify({
        "today": today,
        "current_week": calc_week_of_semester(
            get_current_semester()["start_date"]) if get_current_semester() else 1,
        "total_required": total_required,
        "total_obtained": total_obtained,
        "total_opened": total_opened,
        "opened_other": round(opened_other, 1),
        "categories": cats,
    })


@app.route("/api/grad_requirements")
def api_grad_requirements():
    db = get_db()
    rows = db.execute("SELECT * FROM grad_requirement ORDER BY id").fetchall()
    # 成绩表累计学分：按科目培养类别汇总（有成绩的科目学分）
    auto = {}
    for r in db.execute("""
        SELECT sub.grad_category AS cat, SUM(sub.credit) AS total
        FROM grade g JOIN subject sub ON sub.id = g.subject_id
        WHERE g.score IS NOT NULL AND sub.grad_category IS NOT NULL AND sub.grad_category != ''
        GROUP BY sub.grad_category
    """):
        auto[r["cat"] or ""] = round(r["total"] or 0, 1)
    items = []
    for r in rows:
        d = dict(r)
        if d.get("kind") != "completion":
            # 名称包含匹配（如"学科基础类" ⊂ "学科基础类课程"）
            a = 0.0
            for cat, total in auto.items():
                if d["category"] in cat or cat in d["category"]:
                    a += total
            a = round(a, 1)
            d["auto_obtained"] = a
            # 成绩自动累加 与 手填值取较大者（迁移期不覆盖手填基线）
            d["obtained_credits"] = max(d.get("obtained_credits") or 0, a)
        d["percent"] = grad_percent(d)
        items.append(d)
    return jsonify(items)


def grad_percent(d):
    """达成度：credit 型按已获/要求学分；completion 型按 done 标记"""
    if d.get("kind") == "completion":
        return 100.0 if d.get("done") else 0.0
    if d.get("required_credits"):
        return round(d["obtained_credits"] / d["required_credits"] * 100, 1)
    return 0.0


@app.route("/api/grad_requirements/<int:gid>", methods=["PATCH"])
def api_grad_requirement_update(gid):
    db = get_db()
    row = db.execute("SELECT * FROM grad_requirement WHERE id=?", (gid,)).fetchone()
    if not row:
        return jsonify({"error": "要求不存在"}), 404
    data = request.get_json(silent=True) or {}
    allow = {"category", "required_credits", "obtained_credits", "note", "kind", "done"}
    sets, vals = [], []
    for k, v in data.items():
        if k in allow:
            sets.append(f"{k}=?")
            vals.append(v)
    if not sets:
        return jsonify({"error": "无有效字段"}), 400
    vals.append(datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    db.execute(f"UPDATE grad_requirement SET {', '.join(sets)}, updated_at=? WHERE id=?",
               vals + [gid])
    db.commit()
    row = db.execute("SELECT * FROM grad_requirement WHERE id=?", (gid,)).fetchone()
    d = dict(row)
    d["percent"] = grad_percent(d)
    return jsonify(d)


@app.route("/api/grad_requirements", methods=["POST"])
def api_grad_requirement_create():
    db = get_db()
    data = request.get_json(silent=True) or {}
    category = (data.get("category") or "").strip()
    if not category:
        return jsonify({"error": "请填写达标项名称"}), 400
    # 类型：completion=达标项（勾选式），credit=学分要求；默认达标项
    kind = data.get("kind") or "completion"
    note = (data.get("note") or "").strip()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cur = db.execute(
        "INSERT INTO grad_requirement (category, kind, required_credits, obtained_credits, done, note, medal_img, created_at, updated_at) "
        "VALUES (?,?,0,0,0,?,?,?,?)",
        (category, kind, note, data.get("medal_img") or "", now, now))
    db.commit()
    row = db.execute("SELECT * FROM grad_requirement WHERE id=?", (cur.lastrowid,)).fetchone()
    d = dict(row)
    d["percent"] = grad_percent(d)
    return jsonify(d), 201


@app.route("/api/grad_requirements/<int:gid>", methods=["DELETE"])
def api_grad_requirement_delete(gid):
    db = get_db()
    row = db.execute("SELECT * FROM grad_requirement WHERE id=?", (gid,)).fetchone()
    if not row:
        return jsonify({"error": "要求不存在"}), 404
    db.execute("DELETE FROM grad_requirement WHERE id=?", (gid,))
    db.commit()
    return jsonify({"ok": True})


# ---------------- API：设置与节假日 ----------------

@app.route("/api/settings")
def api_settings():
    db = get_db()
    rows = db.execute("SELECT * FROM settings ORDER BY key").fetchall()
    return jsonify(rows_to_list(rows))


# ---------------- API：手机推送配置（存 settings 表） ----------------

PUSH_KEYS = ["notify_provider", "notify_token", "qmsg_target",
             "pushplus_topic", "pushplus_template", "pushplus_channel", "pushplus_webhook",
             "wecom_corpid", "wecom_secret", "wecom_agentid", "wecom_touser"]


def get_push_config():
    """读取推送配置（settings 表）。用独立连接，供网页 API 与独立脚本共用。"""
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    marks = ",".join(["?"] * len(PUSH_KEYS))
    rows = db.execute(
        f"SELECT key, value FROM settings WHERE key IN ({marks})", PUSH_KEYS).fetchall()
    db.close()
    cfg = {k: "" for k in PUSH_KEYS}
    for r in rows:
        cfg[r["key"]] = r["value"] or ""
    return cfg


def save_push_config(data):
    """保存推送配置到 settings 表（key-value upsert）"""
    db = get_db()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for k in PUSH_KEYS:
        if k in data:
            v = str(data[k] or "").strip()
            db.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, v))
    # 同步 updated 标记（利用现有 settings 无 updated 字段，写回 provider 即可）
    db.commit()
    return get_push_config()


def send_push_msg(title, content, cfg=None):
    """
    通过已配置通道发送一条消息到手机。
    支持三种免费通道（settings.notify_provider 选择）：
      pushplus  -> 微信接收（PushPlus 推送加，token）
      qmsg      -> QQ 接收（Qmsg 酱，key + target）
      wecom     -> 企业微信应用消息（corpid/secret/agentid/touser）
    返回 (ok: bool, msg: str)。
    """
    import urllib.request
    import urllib.parse
    import json as _json

    cfg = cfg or get_push_config()
    provider = (cfg.get("notify_provider") or "pushplus").strip()

    try:
        if provider == "pushplus":
            token = cfg.get("notify_token") or ""
            if not token:
                return False, "未配置 PushPlus token（微信通道）"
            payload = {
                "token": token, "title": title, "content": content,
                # 模板：html（富文本）/ txt（纯文本）/ markdown
                "template": cfg.get("pushplus_template") or "html",
                # 渠道：wechat（推送到微信）/ webhook（自定义机器人）
                "channel": cfg.get("pushplus_channel") or "wechat",
            }
            if cfg.get("pushplus_topic"):
                payload["topic"] = cfg["pushplus_topic"]     # 群组编码
            if cfg.get("pushplus_webhook") and payload["channel"] == "webhook":
                payload["webhook"] = cfg["pushplus_webhook"]  # 自定义机器人地址
            body = _json.dumps(payload, ensure_ascii=False).encode("utf-8")
            req = urllib.request.Request(
                "https://www.pushplus.plus/send", data=body,
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                r = _json.loads(resp.read().decode("utf-8"))
            return (r.get("code") == 200), r.get("msg") or str(r)

        if provider == "qmsg":
            key = cfg.get("notify_token") or ""
            target = (cfg.get("qmsg_target") or "").strip().replace("，", ",")
            if not key:
                return False, "未配置 Qmsg key"
            base = f"https://qmsg.zendee.cn/send/{key}"
            if target:
                base += f"?qq={urllib.parse.quote(target)}"
            data = urllib.parse.urlencode({"msg": f"{title}\n{content}"}).encode("utf-8")
            req = urllib.request.Request(base, data=data)
            with urllib.request.urlopen(req, timeout=10) as resp:
                r = _json.loads(resp.read().decode("utf-8"))
            return bool(r.get("success")), r.get("reason") or str(r)

        if provider == "wecom":
            corpid = (cfg.get("wecom_corpid") or "").strip()
            secret = (cfg.get("wecom_secret") or "").strip()
            agentid = (cfg.get("wecom_agentid") or "").strip()
            touser = (cfg.get("wecom_touser") or "").strip()
            if not (corpid and secret and agentid and touser):
                return False, "企业微信需完整填写 corpid/secret/agentid/touser"
            # 1) 获取 access_token
            turl = ("https://qyapi.weixin.qq.com/cgi-bin/gettoken"
                    f"?corpid={urllib.parse.quote(corpid)}&corpsecret={urllib.parse.quote(secret)}")
            with urllib.request.urlopen(turl, timeout=10) as resp:
                t = _json.loads(resp.read().decode("utf-8"))
            if t.get("errcode") != 0:
                return False, f"获取 access_token 失败：{t.get('errmsg')}"
            token = t["access_token"]
            # 2) 发送文本消息
            murl = ("https://qyapi.weixin.qq.com/cgi-bin/message/send"
                    f"?access_token={urllib.parse.quote(token)}")
            payload = _json.dumps({
                "touser": touser, "msgtype": "text", "agentid": int(agentid),
                "text": {"content": f"{title}\n{content}"},
                "safe": 0,
            }, ensure_ascii=False).encode("utf-8")
            req = urllib.request.Request(murl, data=payload,
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                m = _json.loads(resp.read().decode("utf-8"))
            return (m.get("errcode") == 0), m.get("errmsg") or str(m)

        return False, f"未知推送通道：{provider}"
    except Exception as e:  # noqa: BLE001
        return False, f"发送异常：{e}"


@app.route("/api/push_config")
def api_push_config():
    """读取推送配置（供网页录入界面回显）"""
    return jsonify(get_push_config())


@app.route("/api/push_config", methods=["POST"])
def api_push_config_save():
    """保存推送配置"""
    data = request.get_json(silent=True) or {}
    cfg = save_push_config(data)
    return jsonify({"ok": True, "config": cfg})


@app.route("/api/push_config/test", methods=["POST"])
def api_push_config_test():
    """按当前已保存配置发送一条测试消息"""
    ok, msg = send_push_msg("课程提醒测试", "这是一条测试消息。如果你能收到，说明推送通道配置成功。✅")
    return jsonify({"ok": ok, "msg": msg})


@app.route("/api/holidays")
def api_holidays():
    db = get_db()
    rows = db.execute("SELECT * FROM custom_holiday ORDER BY date").fetchall()
    return jsonify(rows_to_list(rows))


@app.route("/api/holidays", methods=["POST"])
def api_holiday_create():
    db = get_db()
    data = request.get_json(silent=True) or {}
    hdate = data.get("date")
    name = (data.get("name") or "").strip()
    if not hdate or not name:
        return jsonify({"error": "缺少日期或名称"}), 400
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    kind = data.get("kind") or "holiday"
    note = data.get("note") or ""
    db.execute(
        "INSERT INTO custom_holiday (date, kind, name, note, updated_at) VALUES (?,?,?,?,?) "
        "ON CONFLICT(date) DO UPDATE SET name=excluded.name, kind=excluded.kind, "
        "note=excluded.note, updated_at=excluded.updated_at",
        (hdate, kind, name, note, now),
    )
    db.commit()
    row = db.execute("SELECT * FROM custom_holiday WHERE date=?", (hdate,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/api/holidays/<string:hdate>", methods=["DELETE"])
def api_holiday_delete(hdate):
    db = get_db()
    db.execute("DELETE FROM custom_holiday WHERE date=?", (hdate,))
    db.commit()
    return jsonify({"ok": True, "date": hdate})


# ---------------- API：课程备忘（memo 表） ----------------

@app.route("/api/memos")
def api_memos():
    db = get_db()
    cid = request.args.get("course_id", type=int)
    if cid:
        rows = db.execute(
            "SELECT m.*, c.name AS course_name FROM memo m JOIN course c ON c.id=m.course_id "
            "WHERE m.course_id=? ORDER BY m.class_date, m.id", (cid,)).fetchall()
    else:
        rows = db.execute(
            "SELECT m.*, c.name AS course_name FROM memo m JOIN course c ON c.id=m.course_id "
            "ORDER BY m.id").fetchall()
    return jsonify(rows_to_list(rows))


@app.route("/api/memos", methods=["POST"])
def api_memo_create():
    db = get_db()
    data = request.get_json(silent=True) or {}
    course_id = data.get("course_id")
    content = (data.get("content") or "").strip()
    if not course_id or not content:
        return jsonify({"error": "缺少课程或备忘内容"}), 400
    if not db.execute("SELECT 1 FROM course WHERE id=?", (course_id,)).fetchone():
        return jsonify({"error": "课程不存在"}), 404
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cur = db.execute(
        "INSERT INTO memo (course_id, content, is_active, class_date, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?)",
        (course_id, content, int(data.get("is_active", 1) or 1),
         data.get("class_date") or "", now, now),
    )
    db.commit()
    row = db.execute("SELECT * FROM memo WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/api/memos/<int:mid>", methods=["PATCH"])
def api_memo_update(mid):
    db = get_db()
    row = db.execute("SELECT * FROM memo WHERE id=?", (mid,)).fetchone()
    if not row:
        return jsonify({"error": "备忘不存在"}), 404
    data = request.get_json(silent=True) or {}
    allow = {"content", "is_active", "class_date", "done_at"}
    sets, vals = [], []
    for k, v in data.items():
        if k in allow:
            sets.append(f"{k}=?")
            vals.append(v)
    if not sets:
        return jsonify({"error": "无有效字段"}), 400
    vals.append(datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    db.execute(f"UPDATE memo SET {', '.join(sets)}, updated_at=? WHERE id=?", vals + [mid])
    db.commit()
    row = db.execute("SELECT * FROM memo WHERE id=?", (mid,)).fetchone()
    return jsonify(dict(row))


@app.route("/api/memos/<int:mid>", methods=["DELETE"])
def api_memo_delete(mid):
    db = get_db()
    db.execute("DELETE FROM memo WHERE id=?", (mid,))
    db.commit()
    return jsonify({"ok": True, "id": mid})


# ---------------- 启动 ----------------

if __name__ == "__main__":
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    port = int(os.environ.get("PORT", "5050"))
    host = os.environ.get("HOST", "0.0.0.0")  # 默认监听所有网卡，localhost/127.0.0.1/本机IP 均可访问
    print(f"数据库: {DB_PATH}")
    print(f"本地测试平台已启动: http://127.0.0.1:{port}  (host={host})")
    app.run(host=host, port=port, debug=debug)
