/* course-reminder 本地测试平台 · 前端逻辑 */
"use strict";

const $ = (s) => document.querySelector(s);
const api = async (path, opts) => {
  const r = await fetch(path, opts);
  if (r.status === 401) {
    // 会话失效 / 未登录 → 弹回登录页
    showLogin();
    throw new Error("未登录");
  }
  return r.json();
};

/* ---------- 登录 / 登出 / 修改密码 ---------- */
function showLogin() {
  $("#login-mask").classList.remove("hidden");
}
function hideLogin() {
  $("#login-mask").classList.add("hidden");
}
function setUser(name) {
  $("#user-badge").textContent = name ? "👤 " + name : "";
}
async function checkAuth() {
  try {
    const r = await fetch("/api/me");
    if (r.ok) {
      const d = await r.json();
      setUser(d.username || "");
      hideLogin();
      return true;
    }
    showLogin();
    return false;
  } catch (e) {
    showLogin();
    return false;
  }
}
async function doLogin() {
  const username = $("#login-username").value.trim();
  const password = $("#login-password").value;
  const err = $("#login-err");
  if (!username || !password) { err.textContent = "请输入账号和密码"; return; }
  err.textContent = "";
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const d = await r.json();
    if (r.ok) {
      setUser(d.username);
      hideLogin();
      $("#login-password").value = "";
      await reloadAll();
    } else {
      err.textContent = d.error || "登录失败";
    }
  } catch (e) {
    err.textContent = "网络错误，请重试";
  }
}
async function doLogout() {
  try { await fetch("/api/logout", { method: "POST" }); } catch (e) {}
  setUser("");
  showLogin();
}
async function doChangePw() {
  const old = $("#pw-old").value;
  const newp = $("#pw-new").value;
  if (!old || !newp) { alert("请填写原密码和新密码"); return; }
  const r = await fetch("/api/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ old, new: newp }),
  });
  const d = await r.json();
  if (r.ok) {
    alert("密码已修改，请牢记新密码");
    $("#pw-modal").classList.remove("show");
    $("#pw-old").value = "";
    $("#pw-new").value = "";
  } else {
    alert(d.error || "修改失败");
  }
}
async function reloadAll() {
  await loadOverview();
  await loadSemesters();
  await loadSubjects();
  renderSchedule();
  renderEvents();
  renderHolidays();
  renderGradPage();
  renderData();
  renderSemesters();
  renderSubjects();
}

const COLORS = ["#3b6ef6", "#21a179", "#8b5cf6", "#f59e0b", "#ef4444", "#14b8a6"];
const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const PERIODS = Array.from({ length: 12 }, (_, i) => i + 1);

let state = {
  overview: null,
  semesters: [],
  currentSemesterId: null,
  currentWeek: 1,
  subjects: [],
  viewMode: "week",
  monthCursor: null,
};

function colorOf(courseId) {
  return COLORS[Number(courseId) % COLORS.length];
}

/* ---------- 概览 / 学期 ---------- */
async function loadOverview() {
  state.overview = await api("/api/overview");
  state.currentSemesterId = state.overview.current_semester?.id || null;
  state.currentWeek = state.overview.today_week || 1;
  $("#db-badge").textContent = `数据库 ${(state.overview.db_size / 1024).toFixed(0)}KB`;
}

async function loadSemesters() {
  state.semesters = await api("/api/semesters");
  const sel = $("#semester-select");
  const sel2 = $("#course-semester-filter");   // 旧版残留元素，可能不存在
  const sel3 = $("#f-semester");
  if (sel) sel.innerHTML = "";
  if (sel2) sel2.innerHTML = "";
  if (sel3) sel3.innerHTML = "";
  for (const s of state.semesters) {
    const tag = `${s.name}（${s.start_date} 起）${s.is_current ? "★当前" : ""}`;
    if (sel) sel.add(new Option(tag, s.id));
    if (sel2) sel2.add(new Option(s.name, s.id));
    if (sel3) sel3.add(new Option(s.name, s.id));
  }
  if (sel) sel.value = state.currentSemesterId;
  if (sel2) sel2.value = state.currentSemesterId;
  if (sel3) sel3.value = state.currentSemesterId;
  if (sel) sel.onchange = () => { state.currentSemesterId = Number(sel.value); refreshAll(); };
  if (sel2) sel2.onchange = () => renderSemesters();
}

/* ---------- 课表周历 ---------- */
async function renderSchedule() {
  if (!state.currentSemesterId) return;
  const sem = state.semesters.find((s) => s.id === state.currentSemesterId);
  const week = state.currentWeek;
  $("#week-label").textContent = `第${week}周`;
  const tip = sem ? `学期 ${sem.name}` : "";
  $("#week-tip").textContent = tip;

  const courses = await api(`/api/schedule?semester_id=${state.currentSemesterId}&week=${week}`);
  const byKey = new Map();
  for (const c of courses) {
    byKey.set(`${c.day_of_week}-${c.period_start}`, c);
  }

  const table = $("#schedule-table");
  let html = "<tr><th>节次</th>" + DAYS.map((d) => `<th>${d}</th>`).join("") + "</tr>";
  for (const p of PERIODS) {
    html += `<tr><td class="period-label">第${p}节</td>`;
    for (let d = 1; d <= 7; d++) {
      const c = byKey.get(`${d}-${p}`);
      if (c) {
        const span = c.period_end - c.period_start + 1;
        html += `<td rowspan="${span}">${courseCell(c)}</td>`;
      } else {
        html += "<td></td>";
      }
    }
    html += "</tr>";
  }
  table.innerHTML = html;

  // 本周事件（周视图体现事件）
  const events = await api("/api/events");
  const startDate = sem ? new Date(sem.start_date + "T00:00:00") : new Date();
  startDate.setDate(startDate.getDate() + (week - 1) * 7);
  const weekEnd = new Date(startDate.getTime() + 7 * 86400000);
  const weekEvents = events.filter((e) => {
    const d = new Date(e.ev_date + "T00:00:00");
    return d >= startDate && d < weekEnd;
  });
  const we = $("#week-events");
  if (!weekEvents.length) {
    we.innerHTML = '<div class="empty">本周暂无事件</div>';
  } else {
    we.innerHTML = weekEvents.map((e) => `
      <div class="course-item">
        <span class="dot" style="background:#f59e0b"></span>
        <div class="info">
          <div class="t">${escapeHtml(e.title)} <span class="muted">${escapeHtml(e.ev_date)}${e.time ? " " + escapeHtml(e.time) : ""}</span></div>
          ${e.location ? `<div class="d">${escapeHtml(e.location)}</div>` : ""}
        </div>
        <div class="ops"><button class="btn-danger" onclick="deleteEvent(${e.id})">删除</button></div>
      </div>`).join("");
  }
}

/* ---------- 课表月视图 ---------- */
async function renderMonthView() {
  if (!state.currentSemesterId) return;
  const now = new Date();
  if (!state.monthCursor) {
    state.monthCursor = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }
  const ym = state.monthCursor;
  const [year, m] = ym.split("-").map(Number);
  const data = await api(`/api/schedule_month?semester_id=${state.currentSemesterId}&month=${ym}`);
  $("#month-label").textContent = `${data.year} 年 ${data.month_num} 月`;
  const sem = state.semesters.find((s) => s.id === state.currentSemesterId);
  $("#week-tip").textContent = `学期 ${data.semester_name || (sem ? sem.name : "")} · 月历`;

  const first = new Date(year, m - 1, 1).getDay(); // 0=周日
  const startCol = first === 0 ? 6 : first - 1;   // 周一为一周起点
  const todayStr = new Date().toISOString().slice(0, 10);
  let html = `<div class="month-grid-head">${DAYS.map((d) => `<div class="mgh">${d}</div>`).join("")}</div><div class="month-grid">`;
  for (let i = 0; i < startCol; i++) html += `<div class="mday empty"></div>`;
  for (let day = 1; day <= data.ndays; day++) {
    const dstr = `${ym}-${String(day).padStart(2, "0")}`;
    const isToday = dstr === todayStr;
    const cs = data.courses[day] || [];
    const evs = data.events[day] || [];
    const hols = data.holidays[day] || [];
    html += `<div class="mday ${isToday ? "today" : ""} ${hols.length ? "holiday" : ""}">
      <div class="mday-num">${day}${hols.length ? `<span class="hol-tag">${escapeHtml(hols[0].name)}</span>` : ""}</div>
      ${cs.map((c) => `<div class="mcell course" style="background:${colorOf(c.id)}1a;color:${colorOf(c.id)}">${escapeHtml(c.name)}</div>`).join("")}
      ${evs.map((e) => `<div class="mcell event">📌 ${escapeHtml(e.title)}</div>`).join("")}
    </div>`;
  }
  // 补齐尾部到完整一周
  const totalCells = startCol + data.ndays;
  const pad = (7 - (totalCells % 7)) % 7;
  for (let i = 0; i < pad; i++) html += `<div class="mday empty"></div>`;
  html += "</div>";
  $("#month-grid").innerHTML = html;
}

function setScheduleView(mode) {
  state.viewMode = mode;
  const week = mode === "week";
  $("#week-view-box").style.display = week ? "" : "none";
  $("#month-view-box").style.display = week ? "none" : "";
  $("#week-nav").style.display = week ? "" : "none";
  $("#month-nav").style.display = week ? "none" : "";
  $("#go-today").style.display = week ? "" : "none";
  $("#go-month-today").style.display = week ? "none" : "";
  $("#week-input").style.display = week ? "" : "none";
  $("#btn-view-month").style.display = week ? "" : "none";
  $("#btn-view-week").style.display = week ? "none" : "";
  if (!week) renderMonthView();
}

function courseCell(c) {
  const time = c.start_time ? `<span class="sub">${c.start_time}${c.end_time ? "~" + c.end_time : ""}</span>` : "";
  return `<div class="course-cell" style="background:${colorOf(c.id)}">${escapeHtml(c.name)}<span class="sub">${escapeHtml(c.location || "")}</span>${time}</div>`;
}

/* ---------- 课程管理（学期卡片网格 → 学期详情二级界面） ---------- */
let detailSemesterId = null;
let draggingSemId = null;

/* 百分制成绩 → 5.0 制课程绩点（通用 5 分制分档） */
function gpaPoint(score) {
  score = Number(score);
  if (!isFinite(score)) return 0;
  if (score >= 90) return 5.0;
  if (score >= 85) return 4.5;
  if (score >= 80) return 4.0;
  if (score >= 75) return 3.5;
  if (score >= 70) return 3.0;
  if (score >= 65) return 2.5;
  if (score >= 60) return 2.0;
  return 0;
}

/* 某学期综合绩点：课程按科目去重，GPA = Σ(学分×绩点)/Σ学分 */
function semesterGPA(sid, courses, grades) {
  const seen = {};
  let sumCredit = 0, sumPoint = 0, count = 0;
  courses.filter((c) => c.semester_id === sid).forEach((c) => {
    if (!c.subject_id || seen[c.subject_id]) return;
    seen[c.subject_id] = true;
    const g = grades.find((x) => x.subject_id === c.subject_id);
    if (g && g.score !== null && g.score !== "") {
      const p = gpaPoint(g.score);
      const cr = Number(c.credit) || 0;
      sumCredit += cr; sumPoint += p * cr; count++;
    }
  });
  return { gpa: count ? sumPoint / sumCredit : null, count };
}

async function renderSemesters() {
  const [semesters, courses, subjects, grades] = await Promise.all([
    api("/api/semesters"), api("/api/courses"), api("/api/subjects"), api("/api/grades"),
  ]);
  const st = $("#semester-grid");
  if (!semesters.length) { st.innerHTML = '<div class="empty">暂无学期，点击"新增学期"创建</div>'; return; }
  st.innerHTML = semesters.map((s) => {
    const cnt = courses.filter((c) => c.semester_id === s.id).length;
    const subCnt = subjects.filter((x) => x.semester_id === s.id).length;
    const g = semesterGPA(s.id, courses, grades);
    return `<div class="sem-card ${s.is_current ? "current" : ""}" draggable="true" data-id="${s.id}"
      ondragstart="dragSemStart(event, ${s.id})" ondragover="dragSemOver(event)" ondragend="dragSemEnd(event, ${s.id})">
      <div class="sem-card-head">
        <span class="drag-handle" title="拖拽排序">⋮⋮</span>
        <b>${escapeHtml(s.name)}</b>
        ${s.is_current ? '<span class="badge" style="background:#52C41A">当前</span>' : ""}
      </div>
      <div class="sem-card-body">
        <div>开始 ${escapeHtml(s.start_date)} · 绩点制 ${escapeHtml(s.scale || "4.0")}</div>
        <div class="sem-gpa">综合绩点：${g.gpa !== null ? `<b>${g.gpa.toFixed(2)}</b>` : `<span class="muted">暂无成绩</span>`}${g.count ? `<span class="muted">（${g.count} 门有成绩）</span>` : ""}</div>
        <div>${subCnt} 个科目${cnt ? ` · ${cnt} 门排课` : ""}</div>
      </div>
      <div class="sem-card-ops">
        <button class="btn-sm" onclick="openSemesterDetail(${s.id})">进入</button>
        <button class="btn-sm" onclick="openSemesterModal(${s.id})">编辑</button>
        ${!s.is_current ? `<button class="btn-sm" onclick="setCurrentSemester(${s.id})">设为当前</button>` : ""}
      </div>
    </div>`;
  }).join("");
}

function dragSemStart(e, sid) {
  draggingSemId = sid;
  e.dataTransfer.setData("text/plain", String(sid));
  e.dataTransfer.effectAllowed = "move";
  e.target.closest(".sem-card").classList.add("dragging");
}

function dragSemOver(e) {
  e.preventDefault();
  const over = e.target.closest(".sem-card");
  const dragEl = document.querySelector(".sem-card.dragging");
  if (!over || !dragEl || Number(over.dataset.id) === draggingSemId) return;
  const grid = $("#semester-grid");
  const cards = [...grid.querySelectorAll(".sem-card")];
  const from = cards.findIndex((c) => Number(c.dataset.id) === draggingSemId);
  const to = cards.indexOf(over);
  if (from < to) over.after(dragEl); else over.before(dragEl);
}

async function dragSemEnd(e, sid) {
  const el = e.target.closest(".sem-card");
  if (el) el.classList.remove("dragging");
  const ids = [...$("#semester-grid").querySelectorAll(".sem-card")].map((c) => Number(c.dataset.id));
  await api("/api/semesters/reorder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  renderSemesters();
}

async function openSemesterDetail(sid) {
  detailSemesterId = sid;
  const sems = await api("/api/semesters");
  const sem = sems.find((s) => s.id === sid);
  $("#detail-semester-title").textContent = sem ? `学期：${sem.name}` : "学期详情";
  $("#tab-courses").classList.add("hidden");
  $("#tab-semester-detail").classList.remove("hidden");
  await renderSemesterDetail(sid);
}

function backToSemesters() {
  detailSemesterId = null;
  $("#tab-semester-detail").classList.add("hidden");
  $("#tab-courses").classList.remove("hidden");
  renderSemesters();
  renderSubjects();
}

/* 学期详情：该学期排课（相同科目合并展示，课程=科目子表） */
async function renderSemesterDetail(sid) {
  const courses = await api(`/api/courses?semester_id=${sid}`);
  $("#detail-course-count").textContent = `共 ${courses.length} 条排课`;
  const t = $("#detail-course-table");
  if (!courses.length) {
    t.innerHTML = '<tr><td class="empty" colspan="4">该学期暂无排课，点右上角"添加排课"</td></tr>';
    return;
  }
  // 按科目分组：同一科目多条排课合并为一行
  const groups = new Map();
  const singles = [];
  for (const c of courses) {
    if (c.subject_id) {
      if (!groups.has(c.subject_id)) {
        groups.set(c.subject_id, { subject_id: c.subject_id, name: c.subject_name || c.name, credit: c.credit, courses: [] });
      }
      groups.get(c.subject_id).courses.push(c);
    } else {
      singles.push(c);
    }
  }
  const slot = (c) => `第${escapeHtml(c.weeks)}周 ${DAYS[c.day_of_week - 1]} 第${c.period_start}~${c.period_end}节${c.location ? ` · ${escapeHtml(c.location)}` : ""}`;
  const escJs = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, "&quot;");
  let html = "<tr><th>课程</th><th>排课时段</th><th>学分</th><th>操作</th></tr>";
  for (const g of groups.values()) {
    const slots = g.courses.map(slot).join('<span class="slot-sep">｜</span>');
    const nameJs = escJs(g.name);
    html += `<tr>
      <td><b>${escapeHtml(g.name)}</b><div class="muted">${g.courses.length} 个时段</div></td>
      <td>${slots}</td>
      <td>${g.credit}</td>
      <td class="ops">
        <button class="btn-sm" onclick="openCourseGroupModal(${sid}, ${g.subject_id}, '${nameJs}')">排课</button>
        <button class="btn-sm" onclick="openMemoModal(${g.courses[0].id})">备忘</button>
        <button class="btn-danger btn-sm" onclick="deleteSubjectCourses(${g.subject_id}, '${nameJs}')">删除科目</button>
      </td>
    </tr>`;
  }
  for (const c of singles) {
    html += `<tr>
      <td><b>${escapeHtml(c.name)}</b><div class="muted">未关联科目</div></td>
      <td>${slot(c)}</td>
      <td>${c.credit}</td>
      <td class="ops">
        <button class="btn-sm" onclick="openMemoModal(${c.id})">备忘</button>
        <button class="btn-sm" onclick="openCourseModal(${c.id}, ${sid})">编辑</button>
        <button class="btn-danger btn-sm" onclick="deleteCourse(${c.id})">删除</button>
      </td>
    </tr>`;
  }
  t.innerHTML = html;
}

/* 删除某科目在本学期的全部排课（连同科目一起清理排课子表） */
async function deleteSubjectCourses(subjectId, name) {
  if (!confirm(`确定删除「${name}」在本学期的全部排课？`)) return;
  const courses = await api(`/api/courses?semester_id=${detailSemesterId}`);
  const targets = courses.filter((c) => c.subject_id === subjectId);
  for (const c of targets) await api(`/api/courses/${c.id}`, { method: "DELETE" });
  renderSemesterDetail(detailSemesterId);
}

/* 科目排课管理弹窗：列出该科目所有排课（子表），可逐条编辑/删除、新增时段 */
let cgSubjectId = null;
async function openCourseGroupModal(sid, subjectId, name) {
  cgSubjectId = subjectId;
  $("#cg-title").textContent = `排课管理 · ${name}`;
  $("#cg-sub").textContent = `科目：${name}（该科目下的所有排课时段）`;
  await renderCourseGroup(sid);
  $("#course-group-modal").classList.add("show");
}

async function renderCourseGroup(sid) {
  const courses = await api(`/api/courses?semester_id=${sid}`);
  const list = courses.filter((c) => c.subject_id === cgSubjectId);
  const box = $("#cg-list");
  if (!list.length) { box.innerHTML = '<div class="empty">该科目暂无排课，点"新增时段"添加</div>'; return; }
  box.innerHTML = list.map((c) => `
    <div class="cg-item">
      <div class="cg-slot">第${escapeHtml(c.weeks)}周 ${DAYS[c.day_of_week - 1]} 第${c.period_start}~${c.period_end}节${c.location ? ` · ${escapeHtml(c.location)}` : ""}</div>
      <div class="cg-ops">
        <button class="btn-sm" onclick="openCourseModal(${c.id}, ${sid})">编辑</button>
        <button class="btn-danger btn-sm" onclick="deleteCourse(${c.id})">删除</button>
      </div>
    </div>`).join("");
}

/* ---------- 课程备忘（memo 表） ---------- */
let memoCourseId = null;

async function openMemoModal(courseId) {
  memoCourseId = courseId;
  const memos = await api(`/api/memos?course_id=${courseId}`);
  const course = (await api("/api/courses")).find((x) => x.id === courseId);
  $("#memo-modal-title").textContent = `课程备忘 · ${course ? course.name : ""}`;
  $("#memo-input").value = "";
  $("#memo-date").value = "";
  renderMemoList(memos);
  $("#memo-modal").classList.add("show");
}

function renderMemoList(memos) {
  const box = $("#memo-list");
  if (!memos.length) { box.innerHTML = '<div class="empty">暂无备忘，输入内容后点"添加"</div>'; return; }
  box.innerHTML = memos.map((m) => `
    <div class="memo-item ${m.done_at ? "memo-done" : ""}" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px dashed var(--line)">
      <button class="btn-sm" onclick="toggleMemoDone(${m.id}, ${m.done_at ? 0 : 1})">${m.done_at ? "✅" : "⬜"}</button>
      <span style="flex:1;${m.done_at ? "text-decoration:line-through;color:var(--muted)" : ""}">${escapeHtml(m.content)}</span>
      ${m.class_date ? `<span class="muted">${escapeHtml(m.class_date)}</span>` : ""}
      <button class="btn-danger btn-sm" onclick="deleteMemo(${m.id})">删</button>
    </div>`).join("");
}

async function addMemo() {
  const content = $("#memo-input").value.trim();
  if (!content) { alert("请输入备忘内容"); return; }
  await api("/api/memos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ course_id: memoCourseId, content, class_date: $("#memo-date").value }),
  });
  $("#memo-input").value = ""; $("#memo-date").value = "";
  const memos = await api(`/api/memos?course_id=${memoCourseId}`);
  renderMemoList(memos);
}

async function toggleMemoDone(mid, done) {
  await api(`/api/memos/${mid}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ done_at: done ? new Date().toISOString().slice(0, 10) : "" }),
  });
  const memos = await api(`/api/memos?course_id=${memoCourseId}`);
  renderMemoList(memos);
}

function deleteMemo(mid) {
  if (!confirm("确定删除该备忘？")) return;
  api(`/api/memos/${mid}`, { method: "DELETE" }).then(async () => {
    const memos = await api(`/api/memos?course_id=${memoCourseId}`);
    renderMemoList(memos);
  });
}

/* ---------- 自定义假期（custom_holiday 表） ---------- */
async function renderHolidays() {
  const holidays = await api("/api/holidays");
  const box = $("#holiday-list");
  if (!holidays.length) { box.innerHTML = '<div class="empty">暂无假期，放假当天课表照常排课</div>'; return; }
  box.innerHTML = holidays.map((h) => `
    <div class="course-item">
      <span class="dot" style="background:${h.kind === "workday" ? "#f59e0b" : "#ef4444"}"></span>
      <div class="info">
        <div class="t">${escapeHtml(h.name)} <span class="muted">${escapeHtml(h.date)}</span>
          <span class="tag" style="background:${h.kind === "workday" ? "#f59e0b1a" : "#ef44441a"};color:${h.kind === "workday" ? "#d97706" : "#dc2626"}">${h.kind === "workday" ? "调休补课" : "放假"}</span>
        </div>
        ${h.note ? `<div class="d">${escapeHtml(h.note)}</div>` : ""}
      </div>
      <div class="ops"><button class="btn-danger" onclick="deleteHoliday('${h.date}')">删除</button></div>
    </div>`).join("");
}

function openHolidayModal() {
  $("#h-date").value = new Date().toISOString().slice(0, 10);
  $("#h-name").value = ""; $("#h-kind").value = "holiday"; $("#h-note").value = "";
  $("#holiday-modal").classList.add("show");
}

async function saveHoliday() {
  const payload = {
    date: $("#h-date").value,
    name: $("#h-name").value.trim(),
    kind: $("#h-kind").value,
    note: $("#h-note").value.trim(),
  };
  if (!payload.date || !payload.name) { alert("请填写日期和名称"); return; }
  await api("/api/holidays", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  $("#holiday-modal").classList.remove("show");
  renderHolidays();
}

function deleteHoliday(hdate) {
  if (!confirm("确定删除该假期？")) return;
  api(`/api/holidays/${encodeURIComponent(hdate)}`, { method: "DELETE" }).then(() => renderHolidays());
}

function refreshCourseView() {
  if (detailSemesterId) renderSemesterDetail(detailSemesterId);
  else { renderSemesters(); renderSubjects(); }
}

/* ---------- 事件 ---------- */
async function renderEvents() {
  const events = await api("/api/events");
  const box = $("#event-list");
  if (!events.length) { box.innerHTML = '<div class="empty">暂无事件日程</div>'; return; }
  box.innerHTML = events.map((e) => `
    <div class="event-item">
      <div class="date">${e.ev_date}${e.time ? `<br><span class="muted">${e.time}</span>` : ""}</div>
      <div class="title">${escapeHtml(e.title)}${e.location ? `<span class="meta"> · ${escapeHtml(e.location)}</span>` : ""}</div>
      <div class="meta">${e.period ? `<span class="tag" style="background:#3b6ef61a;color:#2563eb">${escapeHtml(e.period)}</span> ` : ""}${e.note ? escapeHtml(e.note) : ""}</div>
      <button class="btn-danger" onclick="deleteEvent(${e.id})">删除</button>
    </div>`).join("");
}

/* ---------- 数据 ---------- */
async function renderData() {
  const o = state.overview;
  $("#stat-grid").innerHTML = `
    <div class="stat"><div class="n">${o.courses}</div><div class="l">课程</div></div>
    <div class="stat"><div class="n">${o.events}</div><div class="l">事件日程</div></div>
    <div class="stat"><div class="n">${o.subjects}</div><div class="l">科目</div></div>
    <div class="stat"><div class="n">${o.semesters}</div><div class="l">学期</div></div>
    <div class="stat"><div class="n">${o.today_week}</div><div class="l">当前第几周</div></div>
    <div class="stat"><div class="n">${(o.db_size / 1024).toFixed(0)}KB</div><div class="l">数据库大小</div></div>`;
  renderSettings();
  loadPushConfig();
}

/* ---------- 数据概览：成就页勋章墙上方统计条 ---------- */
function renderGradStats() {
  const o = state.overview;
  if (!o) return;
  $("#grad-stat-grid").innerHTML = `
    <div class="stat"><div class="n">${o.courses}</div><div class="l">课程</div></div>
    <div class="stat"><div class="n">${o.events}</div><div class="l">事件日程</div></div>
    <div class="stat"><div class="n">${o.subjects}</div><div class="l">科目</div></div>
    <div class="stat"><div class="n">${o.semesters}</div><div class="l">学期</div></div>
    <div class="stat"><div class="n">${o.today_week}</div><div class="l">当前第几周</div></div>
    <div class="stat"><div class="n">${(o.db_size / 1024).toFixed(0)}KB</div><div class="l">数据库大小</div></div>`;
}

/* ---------- 数据概览：课程页学期管理后缩小图标 ---------- */
function renderCourseMiniStats() {
  const o = state.overview;
  if (!o) return;
  const items = [
    ["📘", o.courses, "课程"],
    ["🗓", o.events, "事件"],
    ["📚", o.subjects, "科目"],
    ["📅", o.semesters, "学期"],
    ["📈", o.today_week, "当前周"],
    ["💾", (o.db_size / 1024).toFixed(0) + "KB", "数据库"],
  ];
  $("#course-mini-stats").innerHTML = items.map(([ic, n, l]) =>
    `<span class="mini-stat"><i>${ic}</i><b>${n}</b>${l}</span>`).join("");
}

/* ---------- 毕业要求独立页 ---------- */
const GRAD_COLORS = ["#3b6ef6", "#21a179", "#f59e0b", "#8b5cf6", "#ef4444", "#14b8a6"];
const CATEGORY_COLORS = {
  "通识类课程": "#2563eb", "通识类": "#2563eb",
  "学科基础类": "#10b981", "学科基础": "#10b981",
  "专业类": "#f59e0b", "专业方向": "#f59e0b",
  "实践类": "#8b5cf6"
};
function gradColor(name) {
  let h = 0;
  for (const ch of String(name || "")) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return GRAD_COLORS[h % GRAD_COLORS.length];
}
function catColor(name) { return CATEGORY_COLORS[name] || gradColor(name); }

/* ---------- 勋章系统：毕业事项每完成一项点亮一枚 ---------- */
const MEDALS = [
  { key: "通识类课程", name: "通识奠基", icon: "🎓", desc: "修满通识类 72 学分" },
  { key: "学科基础类", name: "学科筑基", icon: "⚙️", desc: "修满学科基础类 21 学分" },
  { key: "专业类", name: "专业精深", icon: "🔬", desc: "修满专业类 45 学分" },
  { key: "实践类", name: "实践达人", icon: "🛠️", desc: "修满实践类 27.5 学分" },
  { key: "英语四级", name: "四级之星", icon: "🇬🇧", desc: "通过英语四级" },
  { key: "英语六级", name: "六级之星", icon: "🏅", desc: "通过英语六级" },
  { key: "普通话二级", name: "声通四方", icon: "🗣️", desc: "普通话达二级" }
];

function medalEarned(r) {
  if (!r) return false;
  if (r.kind === "completion") return !!r.done;
  return r.required_credits > 0 && r.obtained_credits >= r.required_credits;
}

async function renderMedals() {
  const reqs = await api("/api/grad_requirements");
  let earnedCount = 0;
  const wall = $("#medal-wall");
  wall.innerHTML = MEDALS.map((m) => {
    const r = reqs.find((x) => x.category === m.key);
    const earned = medalEarned(r);
    const img = r && r.medal_img;
    if (earned) earnedCount++;
    return `<div class="medal ${earned ? "earned" : "locked"}">
      <div class="medal-icon">${earned && img ? `<img class="medal-img" src="${img}" alt="勋章">` : m.icon}</div>
      <div class="medal-name">${m.name}</div>
      <div class="medal-desc">${m.desc}</div>
      <div class="medal-state">${earned ? "✦ 已获得" : "未获得"}</div>
    </div>`;
  }).join("");
  $("#medal-summary").textContent = `已获得 ${earnedCount} / ${MEDALS.length}`;
}

/* ---------- 科目勋章墙：按考试成绩赋予称号 ---------- */
const SUBJECT_TITLES = [
  { min: 100, title: "学科传奇", icon: "👑", color: "#f59e0b" },
  { min: 95, title: "学科大师", icon: "🌟", color: "#f59e0b" },
  { min: 90, title: "卓越之星", icon: "🏆", color: "#f59e0b" },
  { min: 85, title: "优秀学霸", icon: "🥇", color: "#94a3b8" },
  { min: 75, title: "良好选手", icon: "🥈", color: "#14b8a6" },
  { min: 60, title: "及格过关", icon: "🥉", color: "#b45309" },
  { min: 0, title: "待努力", icon: "📚", color: "#9ca3af" },
];

function subjectTitle(score) {
  const n = Number(score);
  return SUBJECT_TITLES.find((t) => n >= t.min) || SUBJECT_TITLES[SUBJECT_TITLES.length - 1];
}

/* ---------- 绩点档位：按绩点给徽章上色 + 星数 ---------- */
const GPA_TIERS = [
  { min: 5, label: "S", color: "#8b5cf6", stars: 5 }, // 绩点5 → 紫，5星
  { min: 4, label: "A", color: "#f5b301", stars: 4 }, // 4-5 → 金，4星
  { min: 3, label: "B", color: "#ef4444", stars: 3 }, // 3-4 → 红，3星
  { min: 2, label: "C", color: "#f97316", stars: 2 }, // 2-3 → 橙，2星
  { min: 1, label: "D", color: "#ec4899", stars: 1 }, // 1-2 → 粉，1星
  { min: 0, label: "F", color: "#f1f5f9", stars: 0 }, // 0-1 → 白，0星
];
function gpaTier(score) {
  const p = gpaPoint(score);
  return GPA_TIERS.find((t) => p >= t.min) || GPA_TIERS[GPA_TIERS.length - 1];
}
/* 渲染一排同色五角星（SVG，颜色跟随绩点档位） */
function starRow(tier) {
  if (!tier || tier.stars <= 0) return '<div class="gpa-stars"><span class="gpa-empty">——</span></div>';
  const star = '<svg class="gpa-star" viewBox="0 0 24 24" fill="' + tier.color + '"><path d="M12 2l2.86 6.1 6.64.62-4.98 4.47 1.45 6.52L12 16.83 6.03 19.7l1.45-6.52-4.98-4.47 6.64-.62z"/></svg>';
  let s = "";
  for (let i = 0; i < tier.stars; i++) s += star;
  return '<div class="gpa-stars">' + s + '</div>';
}

async function renderSubjectMedals() {
  const [subjects, grades, badges] = await Promise.all([api("/api/subjects"), api("/api/grades"), api("/api/badges")]);
  const wall = $("#subject-medal-wall");
  const earnedCount = grades.length;
  $("#subject-medal-summary").textContent = `已点亮 ${earnedCount} / ${subjects.length} 门`;
  if (!subjects.length) { wall.innerHTML = '<div class="empty">暂无科目</div>'; return; }
  const badgeBySubject = {};
  (badges || []).forEach((b) => { if (b.subject_id) badgeBySubject[b.subject_id] = b; });
  // 全部科目勋章卡片：玻璃拟态 PNG + 有成绩点亮（绩点颜色修饰+星数），无成绩锁定
  wall.innerHTML = subjects.map((s) => {
    const g = grades.find((x) => x.subject_id === s.id);
    const earned = !!g;
    const tier = earned ? gpaTier(g.score) : null;
    const color = s.grad_category ? catColor(s.grad_category) : "#94a3b8";
    const bd = badgeBySubject[s.id];
    const imgSrc = bd ? ("badges/" + encodeURIComponent(bd.filename)) : (s.medal_img || null);
    const short = s.name.length > 5 ? s.name.slice(0, 5) + "…" : s.name;
    const glow = tier ? `box-shadow:0 0 16px ${tier.color}99, 0 4px 14px rgba(0,0,0,.12); border:3px solid ${tier.color}` : "";
    return `<div class="medal ${earned ? "earned" : "locked"}" style="border-color:${tier ? tier.color + "66" : color + "66"}" title="${escapeHtml(s.name)}">
      <div class="medal-icon">
        ${imgSrc ? `<span class="badge-glow" style="${glow}"><img class="badge-img" src="${imgSrc}" alt="勋章"></span>` : (tier ? starRow(tier) : "🎓")}
      </div>
      <div class="medal-name">${escapeHtml(short)}</div>
      <div class="medal-desc">${s.grad_category ? escapeHtml(s.grad_category) : ""}${s.credit ? ` · ${s.credit}学分` : ""}</div>
      ${earned && tier ? `<div class="medal-tier-badge" style="background:${tier.color}">${tier.label} 绩点 ${gpaPoint(g.score).toFixed(1)}</div>` : ""}
      ${earned ? starRow(tier) : `<div class="gpa-stars"><span class="gpa-empty">未点亮</span></div>`}
      <div class="medal-state" style="color:${tier ? tier.color : ""}">${earned ? `${Number(g.score)}分` : "未获得"}</div>
    </div>`;
  }).join("");
}

async function renderGradPage() {
  const [reqs, gp] = await Promise.all([
    api("/api/grad_requirements"),
    api("/api/grad_progress").catch(() => null),
  ]);
  renderGradStats();
  renderMedals();
  renderSubjectMedals();
  const credits = reqs.filter((r) => r.kind !== "completion");
  const completions = reqs.filter((r) => r.kind === "completion");

  // 1) 总学分堆叠条：四类合并到一条，不同颜色区分 + 已开课/已完成标记
  const totalReq = gp ? gp.total_required : credits.reduce((s, r) => s + (r.required_credits || 0), 0);
  const totalOb = gp ? gp.total_obtained : credits.reduce((s, r) => s + (r.obtained_credits || 0), 0);
  const totalPct = totalReq ? (totalOb / totalReq * 100) : 0;
  if (gp) {
    const cats = gp.categories;
    const stackSegs = cats.map((c) => {
      const col = catColor(c.category);
      const w = totalReq ? (c.required / totalReq * 100) : 0;
      const donePct = c.required ? Math.min(c.obtained / c.required * 100, 100) : 0;
      const short = c.category.replace("类课程", "").replace("类", "");
      return `<div class="stack-seg" style="width:${w}%;background:${col}22;border-right:1px solid #fff">
        <div class="stack-done" style="width:${donePct}%;background:${col}"></div>
        <span class="stack-label" style="color:${col}">${escapeHtml(short)} ${c.obtained}/${c.required}</span>
      </div>`;
    }).join("");
    const openPct = totalReq ? Math.min(gp.total_opened / totalReq * 100, 100) : 0;
    const donePct = totalReq ? Math.min(totalOb / totalReq * 100, 100) : 0;
    $("#grad-total").innerHTML = `
      <div class="grad-head">
        <span class="grad-name">总学分 <span class="muted">（四类合并堆叠）</span></span>
        <span class="grad-nums ${totalOb >= totalReq && totalReq > 0 ? "grad-ok" : ""}">${totalOb} / ${totalReq} 学分 · 达成度 ${totalPct.toFixed(1)}%</span>
      </div>
      <div class="stack-wrap">
        <div class="stack-bar">${stackSegs}</div>
        <div class="stack-marks">
          <div class="mark" style="left:${openPct}%">
            <span class="mark-line" style="border-color:#2563eb"></span>
            <span class="mark-tag" style="background:#2563eb">▲ 已开课 ${gp.total_opened} 学分</span>
          </div>
          <div class="mark" style="left:${donePct}%">
            <span class="mark-line" style="border-color:#16a34a"></span>
            <span class="mark-tag" style="background:#16a34a">● 已完成 ${totalOb} 学分</span>
          </div>
        </div>
      </div>
      <div class="muted" style="margin-top:6px">已开课按当前时间计算（今天 ${gp.today} · 当前学期第 ${gp.current_week} 周，课程开始周 ≤ 当前周即计入）</div>
      <div class="stack-legend">
        ${cats.map((c) => `<span><i style="background:${catColor(c.category)}"></i>${escapeHtml(c.category)} ${c.required} 学分</span>`).join("")}
      </div>`;
  } else {
    $("#grad-total").innerHTML = `
      <div class="grad-head">
        <span class="grad-name">总学分 <span class="muted">（四类合并）</span></span>
        <span class="grad-nums ${totalOb >= totalReq && totalReq > 0 ? "grad-ok" : ""}">${totalOb} / ${totalReq} 学分 · 达成度 ${totalPct.toFixed(1)}%</span>
      </div>
      <div class="progress big">
        <div class="progress-bar" style="width:${Math.min(totalPct, 100)}%;background:linear-gradient(90deg,#2563eb,#8b5cf6)"></div>
      </div>`;
  }

  // 2) 四类学分项（不同颜色）——一行4个紧凑标签
  $("#grad-credit").innerHTML = `<div class="grad-credit-grid">${credits.map((r) => {
    const c = catColor(r.category);
    const pct = Math.min(r.percent || 0, 100);
    const done = r.obtained_credits >= r.required_credits && r.required_credits > 0;
    const short = r.category.replace("类课程", "").replace("类", "");
    return `<div class="grad-chip" style="border-color:${c}55">
      <div class="chip-head">
        <span class="grad-dot" style="background:${c}"></span>
        <b>${escapeHtml(short)}</b>
        <span class="chip-nums ${done ? "grad-ok" : ""}">${r.obtained_credits}/${r.required_credits}</span>
      </div>
      <div class="chip-bar"><div class="chip-done" style="width:${pct}%;background:${c}"></div></div>
      <div class="chip-pct">${r.percent}%</div>
    </div>`;
  }).join("")}</div>`;

  // 3) 达标项——一行多标签
  $("#grad-completion").innerHTML = completions.length ? `<div class="grad-chip-grid">${completions.map((r) => {
    const done = !!r.done;
    return `<div class="grad-chip chip-task">
      <div class="chip-head">
        <span class="chip-status ${done ? "chip-ok" : ""}">${done ? "✓" : "○"}</span>
        <b>${escapeHtml(r.category)}</b>
        <span class="chip-state ${done ? "chip-ok" : ""}">${done ? "已达标" : "未完成"}</span>
        <button class="btn-sm ${done ? "" : "btn-primary"}" onclick="toggleGradDone(${r.id}, ${done ? 1 : 0})">${done ? "取消" : "标记完成"}</button>
        <button class="btn-sm btn-danger" onclick="deleteCompletion(${r.id})" title="删除达标项">✕</button>
      </div>
    </div>`;
  }).join("")}</div>` : '<div class="empty">暂无达标项，点右上角"新增达标项"添加</div>';
}

async function toggleGradDone(gid, currentDone) {
  await api(`/api/grad_requirements/${gid}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ done: currentDone ? 0 : 1 }),
  });
  renderGradPage();
}

/* ---------- 达标项录入（弹出式） ---------- */
function openCompletionModal() {
  $("#c-name").value = "";
  $("#c-note").value = "";
  $("#completion-modal").classList.add("show");
}

async function saveCompletion() {
  const name = $("#c-name").value.trim();
  if (!name) { alert("请填写达标项名称"); return; }
  await api("/api/grad_requirements", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category: name, kind: "completion", note: $("#c-note").value.trim() }),
  });
  $("#completion-modal").classList.remove("show");
  renderGradPage();
}

function deleteCompletion(gid) {
  if (!confirm("确定删除该达标项？")) return;
  api(`/api/grad_requirements/${gid}`, { method: "DELETE" }).then(() => renderGradPage());
}

/* ---------- 科目管理（按学期折叠分组 + 拖拽排序） ---------- */
let draggingSubId = null;

async function renderSubjects() {
  const [subjects, semesters, grades] = await Promise.all([api("/api/subjects"), api("/api/semesters"), api("/api/grades")]);
  const sel = $("#subject-semester-filter");
  const prev = sel.value;
  sel.innerHTML = '<option value="">全部学期</option>' +
    semesters.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
  sel.value = prev !== "" ? prev : "";
  const filter = sel.value;

  const box = $("#subject-list");
  if (!subjects.length) { box.innerHTML = '<div class="empty">暂无科目，点击右上角"新增科目"</div>'; return; }

  const groups = semesters.map((s) => ({ sem: s, subs: subjects.filter((x) => x.semester_id === s.id) }))
    .filter((g) => g.subs.length);
  const noSem = subjects.filter((x) => !x.semester_id);
  if (noSem.length) groups.push({ sem: null, subs: noSem });
  const shown = filter ? groups.filter((g) => g.sem && String(g.sem.id) === filter) : groups;

  box.innerHTML = shown.map((g) => {
    const sname = g.sem ? g.sem.name : "未分学期";
    const totalCredit = g.subs.reduce((a, s) => a + (Number(s.credit) || 0), 0).toFixed(1);
    return `<div class="subject-group" data-sem="${g.sem ? g.sem.id : ""}">
      <div class="subject-group-head" onclick="toggleSubjectGroup(this)"
        title="${escapeHtml(sname)}：${g.subs.length} 门 · 合计 ${totalCredit} 学分 —— 点击展开/收起，组内可拖拽排序">
        <span class="sg-arrow">▸</span>
        <b>${escapeHtml(sname)}</b>
        <span class="sg-meta">${g.subs.length}科 · ${totalCredit}分</span>
      </div>
      <div class="subject-group-body" style="display:none">
        ${g.subs.map((s) => {
          const gd = grades.find((x) => x.subject_id === s.id);
          const pt = gd ? gpaPoint(gd.score) : null;
          const tierColor = gd ? gpaTier(gd.score).color : "";
          return `
        <div class="course-item" draggable="true" data-id="${s.id}"
          ondragstart="dragSubStart(event, ${s.id})" ondragover="dragSubOver(event)" ondragend="dragSubEnd(event, ${s.id})">
          <span class="drag-handle" title="拖拽排序">⋮⋮</span>
          <span class="dot" style="background:${colorOf(s.id)}"></span>
          <div class="info">
            <div class="t">${s.medal_img ? `<img class="subj-medal" src="${s.medal_img}" alt="勋章">` : ""}${escapeHtml(s.name)}</div>
            <div class="d">学分${s.credit}${s.location ? ` · ${escapeHtml(s.location)}` : ""}
              ${s.grad_category ? `<span class="tag" style="background:${gradColor(s.grad_category)}1a;color:${gradColor(s.grad_category)}">${escapeHtml(s.grad_category)}</span>` : ""}
              ${s.course_type ? `<span class="tag" style="background:#3b6ef61a;color:#2563eb">${escapeHtml(s.course_type)}</span>` : ""}
              ${s.assessment_method ? `<span class="tag" style="background:#21a1791a;color:#15803d">${escapeHtml(s.assessment_method)}</span>` : ""}
              ${gd ? `<span class="grade-pill" style="color:${tierColor};border-color:${tierColor}66">成绩 ${gd.score} · GPA ${pt.toFixed(1)}</span>` : ""}
            </div>
          </div>
          <div class="ops">
            <button class="btn-sm" onclick="openGradeModal(${s.id})">${gd ? "改成绩" : "录成绩"}</button>
            <button class="btn-sm" onclick="openSubjectModal(${s.id})">编辑</button>
            <button class="btn-danger btn-sm" onclick="deleteSubject(${s.id})">删除</button>
          </div>
        </div>`;
        }).join("")}
      </div>
    </div>`;
  }).join("");
}

function toggleSubjectGroup(head) {
  const body = head.nextElementSibling;
  const arrow = head.querySelector(".sg-arrow");
  const collapsed = body.style.display === "none";
  body.style.display = collapsed ? "" : "none";
  arrow.textContent = collapsed ? "▾" : "▸";
}

function dragSubStart(e, sid) {
  draggingSubId = sid;
  e.dataTransfer.setData("text/plain", String(sid));
  e.dataTransfer.effectAllowed = "move";
  e.target.closest(".course-item").classList.add("dragging");
}

function dragSubOver(e) {
  e.preventDefault();
  const item = e.target.closest(".course-item");
  const dragEl = document.querySelector(".course-item.dragging");
  if (!item || !dragEl || String(item.dataset.id) === String(draggingSubId)) return;
  const group = dragEl.closest(".subject-group");
  if (!group.contains(item)) return;
  const items = [...group.querySelectorAll(".course-item")];
  const from = items.findIndex((x) => String(x.dataset.id) === String(draggingSubId));
  const to = items.indexOf(item);
  if (from < to) item.after(dragEl); else item.before(dragEl);
}

async function dragSubEnd(e, sid) {
  const el = e.target.closest(".course-item");
  if (el) el.classList.remove("dragging");
  const group = document.querySelector(`.course-item[data-id="${sid}"]`)?.closest(".subject-group");
  if (!group) return;
  const ids = [...group.querySelectorAll(".course-item")].map((x) => Number(x.dataset.id));
  await api("/api/subjects/reorder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  renderSubjects();
}

/* ---------- 科目管理：成绩录入 ---------- */
let editingGradeSubjectId = null;
let gradeSubjectName = "";

async function openGradeModal(sid) {
  const subjects = await api("/api/subjects");
  const s = subjects.find((x) => x.id === sid);
  if (!s) return;
  editingGradeSubjectId = sid;
  gradeSubjectName = s.name;
  $("#g-subject-name").value = s.name;
  const grades = await api("/api/grades");
  const g = grades.find((x) => x.subject_id === sid);
  $("#g-score").value = g ? g.score : "";
  $("#btn-g-clear").classList.toggle("hidden", !g);
  updateGradePreview();
  $("#grade-modal").classList.add("show");
}

function updateGradePreview() {
  const score = $("#g-score").value.trim();
  const box = $("#g-preview");
  if (!score || isNaN(Number(score))) {
    box.innerHTML = "输入成绩后实时预览绩点档位与勋章星数";
    return;
  }
  const n = Number(score);
  const p = gpaPoint(n);
  const tier = gpaTier(n);
  const dots = "●".repeat(tier.stars || 1);
  box.innerHTML = `成绩 ${n} 分 → <b>绩点 ${p.toFixed(1)}</b> · ${tier.label} 档 · <span style="color:${tier.color}">${dots}</span> ×${tier.stars}星`;
}

async function saveGradeFromSubject() {
  const score = $("#g-score").value.trim();
  if (!score || isNaN(Number(score))) { alert("请填写有效成绩（0-100）"); return; }
  await api("/api/grades", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject_id: editingGradeSubjectId, score: Number(score) }),
  });
  $("#grade-modal").classList.remove("show");
  refreshAfterGrade();
}

function clearGradeFromSubject() {
  if (!confirm(`确定清除「${gradeSubjectName}」的成绩？`)) return;
  api("/api/grades").then(async (grades) => {
    const g = grades.find((x) => x.subject_id === editingGradeSubjectId);
    if (g) await api(`/api/grades/${g.id}`, { method: "DELETE" });
    $("#grade-modal").classList.remove("show");
    refreshAfterGrade();
  });
}

function refreshAfterGrade() {
  renderSubjects();
  renderGradPage();
  renderSemesters();
  loadOverview();
  if (detailSemesterId) renderSemesterDetail(detailSemesterId);
}

/* ---------- 推送配置（只读） ---------- */
/* settings 表配置项中文说明映射 */
const SETTINGS_DESC = {
  "app_base_url": "应用基础 URL",
  "cloud_sync_url": "云端同步地址",
  "grad_credit_weight": "毕业学分权重",
  "notify_provider": "推送通道（pushplus / qmsg / wecom）",
  "notify_token": "推送 Token（PushPlus token 或 Qmsg key）",
  "pushplus_channel": "PushPlus 发送渠道（wechat 推送到微信 / webhook 自定义机器人）",
  "pushplus_template": "PushPlus 消息模板（html 富文本 / txt 纯文本 / markdown）",
  "pushplus_topic": "PushPlus 群组编码（空=发给个人，填了=发到指定群组）",
  "pushplus_webhook": "PushPlus 自定义机器人地址（仅渠道=webhook 时生效）",
  "qmsg_target": "Qmsg 目标 QQ 号（可多个，逗号分隔）",
  "sync_enabled": "是否启用云端同步（1=启用，0=关闭）",
  "sync_interval_min": "云端同步间隔（分钟）",
  "sync_mode": "同步模式（both 双向 / upload 上传 / download 下载）",
  "sync_token": "云端同步令牌",
  "wecom_agentid": "企业微信应用 ID（agentid）",
  "wecom_corpid": "企业微信企业 ID（corpid）",
  "wecom_secret": "企业微信应用密钥（secret）",
  "wecom_touser": "企业微信接收人（touser，@all=全部成员）",
};

async function renderSettings() {
  const settings = await api("/api/settings");
  const st = $("#settings-table");
  st.innerHTML = "<tr><th>配置项</th><th>值</th><th>说明</th></tr>" + settings.map((x) =>
    `<tr><td>${escapeHtml(x.key)}</td><td>${escapeHtml(x.value || "")}</td><td class="muted" style="font-size:12px">${escapeHtml(SETTINGS_DESC[x.key] || "")}</td></tr>`).join("");
}

/* ---------- 推送设置（存 settings 表，网页录入） ---------- */
async function loadPushConfig() {
  const cfg = await api("/api/push_config");
  $("#pf-provider").value = cfg.notify_provider || "pushplus";
  $("#pf-token").value = cfg.notify_token || "";
  $("#pf-topic").value = cfg.pushplus_topic || "";
  $("#pf-template").value = cfg.pushplus_template || "html";
  $("#pf-channel").value = cfg.pushplus_channel || "wechat";
  $("#pf-webhook").value = cfg.pushplus_webhook || "";
  $("#pf-qmsg-target").value = cfg.qmsg_target || "";
  $("#pf-wecom-corpid").value = cfg.wecom_corpid || "";
  $("#pf-wecom-secret").value = cfg.wecom_secret || "";
  $("#pf-wecom-agentid").value = cfg.wecom_agentid || "";
  $("#pf-wecom-touser").value = cfg.wecom_touser || "";
  updatePushRows();
}

/* 按通道只显示对应输入行；webhook 行仅在 pushplus + webhook 渠道时显示 */
function updatePushRows() {
  const p = $("#pf-provider").value;
  const ch = $("#pf-channel") ? $("#pf-channel").value : "wechat";
  [["pf-pushplus", "pushplus"], ["pf-qmsg", "qmsg"], ["pf-wecom", "wecom"]].forEach(([cls, name]) => {
    document.querySelectorAll("." + cls).forEach((el) => {
      const isWebhookRow = el.classList.contains("pf-pushplus-webhook");
      let show = (p === name);
      if (isWebhookRow) show = (p === "pushplus" && ch === "webhook");
      el.style.display = show ? "" : "none";
    });
  });
}

async function savePushConfig() {
  const payload = {
    notify_provider: $("#pf-provider").value,
    notify_token: $("#pf-token").value.trim(),
    pushplus_topic: $("#pf-topic").value.trim(),
    pushplus_template: $("#pf-template").value,
    pushplus_channel: $("#pf-channel").value,
    pushplus_webhook: $("#pf-webhook").value.trim(),
    qmsg_target: $("#pf-qmsg-target").value.trim(),
    wecom_corpid: $("#pf-wecom-corpid").value.trim(),
    wecom_secret: $("#pf-wecom-secret").value.trim(),
    wecom_agentid: $("#pf-wecom-agentid").value.trim(),
    wecom_touser: $("#pf-wecom-touser").value.trim(),
  };
  const r = await api("/api/push_config", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  $("#push-msg").textContent = r.ok ? "✅ 推送配置已保存" : "保存失败";
  renderSettings();
}

async function testPush() {
  await savePushConfig();
  $("#push-msg").textContent = "正在发送测试消息，请留意手机...";
  const r = await api("/api/push_config/test", { method: "POST" });
  $("#push-msg").textContent = r.ok ? ("✅ " + (r.msg || "测试消息已发送，请查看手机")) : ("❌ " + r.msg);
}

/* ---------- 课程弹窗 ---------- */
let editingCourseId = null;

async function loadSubjects() {
  state.subjects = await api("/api/subjects");
}

/* 科目下拉：只显示指定学期的科目（科目名即课程名） */
function fillSubjectOptions(semesterId, selectedId) {
  const sel = $("#f-subject");
  const opts = state.subjects.filter((s) => String(s.semester_id) === String(semesterId));
  sel.innerHTML = opts.length
    ? opts.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("")
    : '<option value="">（该学期暂无科目，请先新增科目）</option>';
  if (selectedId) sel.value = String(selectedId);
}

function openCourseModal(cid, defaultSemesterId, preselectSubjectId) {
  editingCourseId = cid;
  $("#course-modal-title").textContent = cid ? "编辑排课" : "添加排课";
  if (cid) {
    api(`/api/courses`).then((all) => {
      const c = all.find((x) => x.id === cid);
      if (!c) return;
      $("#f-semester").value = c.semester_id;
      fillSubjectOptions(c.semester_id, c.subject_id || undefined);
      $("#f-location").value = c.location || "";
      $("#f-day").value = c.day_of_week;
      $("#f-weeks").value = c.weeks;
      $("#f-period-start").value = c.period_start;
      $("#f-period-end").value = c.period_end;
      $("#f-start-time").value = c.start_time || "";
      $("#f-end-time").value = c.end_time || "";
      $("#f-credit").value = c.credit || 0;
      $("#f-memo").value = c.memo || "";
    });
  } else {
    const semId = defaultSemesterId || state.currentSemesterId || "";
    $("#f-semester").value = semId;
    fillSubjectOptions(semId, preselectSubjectId);
    $("#f-location").value = "";
    $("#f-day").value = "1"; $("#f-weeks").value = "4-15"; $("#f-period-start").value = "1";
    $("#f-period-end").value = "2"; $("#f-start-time").value = ""; $("#f-end-time").value = "";
    $("#f-credit").value = "0"; $("#f-memo").value = "";
  }
  $("#course-modal").classList.add("show");
}

async function saveCourse() {
  const subjId = $("#f-subject").value;
  if (!subjId) { alert("请选择科目（课程名取科目名）"); return; }
  const sel = $("#f-subject");
  const name = sel.options[sel.selectedIndex]?.textContent.trim() || "";
  const payload = {
    semester_id: Number($("#f-semester").value),
    name,
    subject_id: Number(subjId),
    location: $("#f-location").value.trim(),
    day_of_week: Number($("#f-day").value),
    weeks: $("#f-weeks").value.trim(),
    period_start: Number($("#f-period-start").value),
    period_end: Number($("#f-period-end").value),
    start_time: $("#f-start-time").value.trim(),
    end_time: $("#f-end-time").value.trim(),
    credit: Number($("#f-credit").value) || 0,
    memo: $("#f-memo").value.trim(),
  };
  const path = editingCourseId ? `/api/courses/${editingCourseId}` : "/api/courses";
  const method = editingCourseId ? "PATCH" : "POST";
  await api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  $("#course-modal").classList.remove("show");
  $("#course-group-modal").classList.remove("show");
  refreshCourseView();
}

function deleteCourse(id) {
  if (!confirm("确定删除该排课？")) return;
  api(`/api/courses/${id}`, { method: "DELETE" }).then(() => {
    refreshCourseView();
    if ($("#course-group-modal").classList.contains("show") && detailSemesterId) renderCourseGroup(detailSemesterId);
  });
}

/* ---------- 事件弹窗 ---------- */
function openEventModal() {
  $("#e-date").value = new Date().toISOString().slice(0, 10);
  $("#e-time").value = ""; $("#e-title").value = ""; $("#e-location").value = ""; $("#e-note").value = ""; $("#e-period").value = "";
  $("#event-modal").classList.add("show");
}

async function saveEvent() {
  const payload = {
    ev_date: $("#e-date").value, time: $("#e-time").value.trim(),
    title: $("#e-title").value.trim(), location: $("#e-location").value.trim(),
    note: $("#e-note").value.trim(), period: $("#e-period").value.trim(),
  };
  if (!payload.ev_date || !payload.title) { alert("请填写日期和标题"); return; }
  await api("/api/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  $("#event-modal").classList.remove("show");
  renderEvents();
}

function deleteEvent(id) {
  if (!confirm("确定删除该事件？")) return;
  api(`/api/events/${id}`, { method: "DELETE" }).then(() => renderEvents());
}

/* ---------- 科目弹窗 ---------- */
let editingSubjectId = null;

function openSubjectModal(sid) {
  editingSubjectId = sid;
  $("#subject-modal-title").textContent = sid ? "编辑科目" : "新增科目";
  // 填充学期下拉
  const sel = $("#s-semester");
  sel.innerHTML = state.semesters.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
  // 填充培养类别下拉（只取学分型毕业要求）
  api("/api/grad_requirements").then((reqs) => {
    const cats = reqs.filter((r) => r.kind !== "completion").map((r) => r.category);
    const gc = $("#s-grad-category");
    gc.innerHTML = '<option value="">（未分类）</option>' +
      cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    if (sid) {
      api("/api/subjects").then((all) => {
        const s = all.find((x) => x.id === sid);
        if (!s) return;
        $("#s-name").value = s.name;
        $("#s-semester").value = s.semester_id;
        $("#s-credit").value = s.credit || 0;
        $("#s-location").value = s.location || "";
        $("#s-grad-category").value = s.grad_category || "";
        $("#s-course-type").value = s.course_type || "";
        $("#s-assessment-method").value = s.assessment_method || "";
        $("#s-medal-img").value = s.medal_img || "";
      });
    }
  });
  if (!sid) {
    $("#s-name").value = "";
    $("#s-semester").value = state.currentSemesterId || "";
    $("#s-credit").value = "0";
    $("#s-location").value = "";
    $("#s-course-type").value = "";
    $("#s-assessment-method").value = "";
    $("#s-medal-img").value = "";
  }
  $("#subject-modal").classList.add("show");
}

async function saveSubject() {
  const payload = {
    semester_id: Number($("#s-semester").value),
    name: $("#s-name").value.trim(),
    credit: Number($("#s-credit").value) || 0,
    location: $("#s-location").value.trim(),
    grad_category: $("#s-grad-category").value,
    course_type: $("#s-course-type").value,
    assessment_method: $("#s-assessment-method").value,
    medal_img: $("#s-medal-img").value.trim(),
  };
  if (!payload.name || !payload.semester_id) { alert("请填写科目名和学期"); return; }
  const path = editingSubjectId ? `/api/subjects/${editingSubjectId}` : "/api/subjects";
  const method = editingSubjectId ? "PATCH" : "POST";
  await api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  $("#subject-modal").classList.remove("show");
  loadSubjects();
  renderSubjects();
  renderSemesters();
  renderGradPage();
}

/* ---------- 科目批量导入 ---------- */
function openImportSubjectModal() {
  const sel = $("#imp-semester");
  sel.innerHTML = state.semesters.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
  if (state.semesters.length) {
    const cur = state.semesters.find((s) => s.id === state.currentSemesterId);
    sel.value = cur ? cur.id : state.semesters[0].id;
  }
  $("#imp-text").value = "";
  $("#import-result").textContent = "";
  $("#import-subject-modal").classList.add("show");
}

async function saveImportSubjects() {
  const semId = Number($("#imp-semester").value);
  const text = $("#imp-text").value.trim();
  if (!text) { alert("请粘贴科目列表"); return; }
  const items = [];
  const parseFails = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    line = line.trim();
    if (!line) return;
    const parts = line.split(/[,，\t]+/).map((p) => p.trim());
    const name = parts[0];
    if (!name) { parseFails.push(`第${idx + 1}行缺科目名`); return; }
    items.push({
      name,
      semester_id: semId,
      credit: parts[1] ? (Number(parts[1]) || 0) : 0,
      grad_category: parts[2] || "",
      location: parts[3] || "",
    });
  });
  if (!items.length) { alert("没有可导入的科目，请检查格式"); return; }
  const r = await api("/api/subjects/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  let html = `成功导入 <b>${r.ok}</b> 条`;
  if (r.fail && r.fail.length) {
    html += `，失败 <b>${r.fail.length}</b> 条：<br>` +
      r.fail.map((f) => `第${f.row}行 ${escapeHtml(f.err || "")}`).join("<br>");
  }
  if (parseFails.length) html += `<br>格式错误：${parseFails.map(escapeHtml).join("；")}`;
  $("#import-result").innerHTML = html;
  renderSubjects();
  loadSubjects();
  renderSemesters();
  renderGradPage();
}

function deleteSubject(id) {
  if (!confirm("确定删除该科目？关联的课程与成绩将一并移除。")) return;
  api(`/api/subjects/${id}`, { method: "DELETE" }).then(() => {
    loadSubjects(); renderSubjects(); renderSemesters(); renderGradPage();
  });
}

/* ---------- 学期弹窗 ---------- */
let editingSemesterId = null;

function openSemesterModal(sid) {
  editingSemesterId = sid;
  $("#semester-modal-title").textContent = sid ? "编辑学期" : "新增学期";
  if (sid) {
    api("/api/semesters").then((all) => {
      const s = all.find((x) => x.id === sid);
      if (!s) return;
      $("#m-name").value = s.name;
      $("#m-start").value = s.start_date;
      $("#m-scale").value = s.scale || "4.0";
      $("#m-current").checked = !!s.is_current;
    });
  } else {
    $("#m-name").value = "";
    $("#m-start").value = new Date().toISOString().slice(0, 10);
    $("#m-scale").value = "5.0";
    $("#m-current").checked = false;
  }
  $("#semester-modal").classList.add("show");
}

async function saveSemester() {
  const payload = {
    name: $("#m-name").value.trim(),
    start_date: $("#m-start").value,
    scale: $("#m-scale").value,
    is_current: $("#m-current").checked ? 1 : 0,
  };
  if (!payload.name || !payload.start_date) { alert("请填写学期名和开始日期"); return; }
  let saved;
  if (editingSemesterId) {
    saved = await api(`/api/semesters/${editingSemesterId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } else {
    saved = await api("/api/semesters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
  if (payload.is_current && saved && saved.id) {
    await api(`/api/semesters/${saved.id}/current`, { method: "POST" });
  }
  $("#semester-modal").classList.remove("show");
  await loadSemesters();
  await loadOverview();
  renderSemesters();
  refreshAll();
}

function setCurrentSemester(id) {
  if (!confirm("确定将该学期设为当前学期？")) return;
  api(`/api/semesters/${id}/current`, { method: "POST" }).then(async () => {
    await loadSemesters(); await loadOverview();
    renderSemesters(); refreshAll();
  });
}

/* ---------- 工具 ---------- */
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

/* ---------- 导航 ---------- */
document.querySelectorAll("nav button").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll("nav button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    ["schedule", "courses", "events", "grad", "data"].forEach((t) =>
      $(`#tab-${t}`).classList.toggle("hidden", t !== btn.dataset.tab));
    if (btn.dataset.tab === "schedule") { renderSchedule(); if (state.viewMode === "month") renderMonthView(); }
    if (btn.dataset.tab === "courses") { renderSemesters(); renderSubjects(); renderCourseMiniStats(); }
    if (btn.dataset.tab === "events") { renderEvents(); renderHolidays(); }
    if (btn.dataset.tab === "grad") renderGradPage();
    if (btn.dataset.tab === "data") renderData();
  };
});

function refreshAll() {
  renderSchedule();
  if (state.viewMode === "month") renderMonthView();
  renderSemesters();
}

/* ---------- 事件绑定 ---------- */
$("#prev-week").onclick = () => { if (state.currentWeek > 1) { state.currentWeek--; renderSchedule(); } };
$("#next-week").onclick = () => { if (state.currentWeek < (state.overview?.max_week || 30)) { state.currentWeek++; renderSchedule(); } };
$("#go-today").onclick = () => { state.currentWeek = state.overview.today_week; renderSchedule(); };
$("#week-input").onchange = (e) => {
  const v = Number(e.target.value);
  if (v >= 1 && v <= (state.overview?.max_week || 30)) { state.currentWeek = v; renderSchedule(); }
};
$("#btn-view-month").onclick = () => setScheduleView("month");
$("#btn-view-week").onclick = () => setScheduleView("week");
$("#prev-month").onclick = () => {
  const [y, m] = state.monthCursor.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  state.monthCursor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  renderMonthView();
};
$("#next-month").onclick = () => {
  const [y, m] = state.monthCursor.split("-").map(Number);
  const d = new Date(y, m, 1);
  state.monthCursor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  renderMonthView();
};
$("#go-month-today").onclick = () => {
  const n = new Date();
  state.monthCursor = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`;
  renderMonthView();
};
$("#btn-add-week-event").onclick = openEventModal;
$("#btn-add-course").onclick = () => openCourseModal(null, detailSemesterId);
$("#btn-back-semesters").onclick = backToSemesters;
$("#btn-modal-cancel").onclick = () => $("#course-modal").classList.remove("show");
$("#btn-modal-save").onclick = saveCourse;
$("#f-semester").onchange = (e) => fillSubjectOptions(e.target.value);
$("#btn-cg-add").onclick = () => { $("#course-group-modal").classList.remove("show"); openCourseModal(null, detailSemesterId, cgSubjectId); };
$("#btn-cg-close").onclick = () => $("#course-group-modal").classList.remove("show");
$("#pf-provider").onchange = updatePushRows;
$("#pf-channel").onchange = updatePushRows;
$("#btn-push-save").onclick = savePushConfig;
$("#btn-push-test").onclick = testPush;
$("#btn-add-event").onclick = openEventModal;
$("#btn-event-cancel").onclick = () => $("#event-modal").classList.remove("show");
$("#btn-event-save").onclick = saveEvent;
$("#btn-add-holiday").onclick = openHolidayModal;
$("#btn-holiday-cancel").onclick = () => $("#holiday-modal").classList.remove("show");
$("#btn-holiday-save").onclick = saveHoliday;
$("#btn-memo-add").onclick = addMemo;
$("#btn-memo-close").onclick = () => $("#memo-modal").classList.remove("show");
$("#btn-add-subject").onclick = () => openSubjectModal(null);
$("#subject-semester-filter").onchange = () => renderSubjects();
$("#btn-import-subjects").onclick = openImportSubjectModal;
$("#btn-import-cancel").onclick = () => $("#import-subject-modal").classList.remove("show");
$("#btn-import-save").onclick = saveImportSubjects;
$("#btn-subject-cancel").onclick = () => $("#subject-modal").classList.remove("show");
$("#btn-subject-save").onclick = saveSubject;
$("#btn-g-cancel").onclick = () => $("#grade-modal").classList.remove("show");
$("#btn-g-save").onclick = saveGradeFromSubject;
$("#btn-g-clear").onclick = clearGradeFromSubject;
$("#g-score").oninput = updateGradePreview;
$("#btn-c-cancel").onclick = () => $("#completion-modal").classList.remove("show");
$("#btn-c-save").onclick = saveCompletion;
$("#btn-add-semester").onclick = () => openSemesterModal(null);
$("#btn-semester-cancel").onclick = () => $("#semester-modal").classList.remove("show");
$("#btn-semester-save").onclick = saveSemester;
document.querySelectorAll(".modal-mask").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) m.classList.remove("show"); }));

/* ---------- 登录 / 登出 / 改密 事件 ---------- */
$("#btn-login").onclick = doLogin;
$("#login-password").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
$("#login-username").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#login-password").focus(); });
$("#btn-logout").onclick = doLogout;
$("#btn-change-pw").onclick = () => $("#pw-modal").classList.add("show");
$("#btn-pw-cancel").onclick = () => $("#pw-modal").classList.remove("show");
$("#btn-pw-save").onclick = doChangePw;

/* ---------- 启动 ---------- */
(async function init() {
  if (!(await checkAuth())) return; // 未登录：停在登录页
  await reloadAll();
})();
