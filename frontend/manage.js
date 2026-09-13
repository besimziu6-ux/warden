"use strict";

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(window.location.search);
const serverId = qs.get("id") || "";

const store = {
  get token() { return localStorage.getItem("warden_token") || localStorage.getItem("gp_token") || ""; },
  set token(v) {
    if (v) localStorage.setItem("warden_token", v);
    else { localStorage.removeItem("warden_token"); localStorage.removeItem("gp_token"); }
  },
};

let server = null;
let curPath = "";
let editingPath = "";
let ws = null;
let term = null;
let useTerm = false;
let reconnectTimer = null;

function toast(msg, kind) {
  const box = $("toast");
  if (!box) return;
  while (box.children.length >= 4) box.firstChild.remove();
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = String(msg);
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 250); }, 4200);
}

function fmtSize(n) {
  if (n == null) return "-";
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + " MB";
  return (v / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

function fmtDate(s) {
  if (!s) return "-";
  try {
    const d = new Date(s);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return String(s); }
}

function setWsState(text, live) {
  const el = $("wsState");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("live", !!live);
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function initials(name) {
  const s = String(name || "?").trim();
  if (!s) return "?";
  const parts = s.split(/[\s\-_]+/);
  return ((parts[0] || "?")[0] + ((parts[1] || "")[0] || "")).toUpperCase() || "?";
}

function avatarClass(game) {
  const g = String(game || "");
  if (g.includes("minecraft")) return "mc";
  if (g === "cs2") return "cs";
  if (g === "rust") return "rust";
  if (g === "ark") return "ark";
  if (g === "valheim") return "val";
  if (g === "terraria") return "ter";
  return "";
}

function authHeaders(json) {
  const h = {};
  if (json) h["Content-Type"] = "application/json";
  if (store.token) h.Authorization = "Bearer " + store.token;
  return h;
}

async function api(path, opts) {
  const res = await fetch(path, {
    method: (opts && opts.method) || "GET",
    headers: authHeaders(!(opts && opts.raw)),
    body: (opts && opts.body) ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = new Error((data && data.error) || ("request failed: " + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

function needLogin() {
  toast("Session expired, please login", "err");
  window.location.href = "/?next=" + encodeURIComponent(window.location.pathname + window.location.search);
}

/* ---- header / power ---- */
function paintServer() {
  if (!server) return;
  const st = server.status || "created";
  try { localStorage.setItem("warden_last", serverId); } catch { /* noop */ }
  document.title = (server.name || "Server") + " — Warden";
  $("srvTitle").textContent = server.name || serverId;
  const cn = $("crumbName");
  if (cn) cn.textContent = server.name || serverId;
  const icon = $("srvIcon");
  if (icon) {
    icon.textContent = initials(server.name);
    icon.className = "srv-icon " + avatarClass(server.game);
  }
  const pill = $("srvStatus");
  pill.textContent = st;
  pill.className = "pill " + st;
  const ports = (server.ports || []).map((p) => p.container + "/" + (p.protocol || "tcp")).join(", ") || "—";
  const meta = $("srvMeta");
  if (meta) meta.innerHTML = esc(server.game || "") + " · <code class='inline'>" + esc(serverId.slice(0, 8)) + "</code> · <code class='inline'>" + esc(ports) + "</code>";
  const ss = $("sideStatus");
  if (ss) ss.textContent = (server.name || serverId) + " · " + st;
  const sub = $("sideSub");
  if (sub) sub.textContent = (server.game || "") + " · " + ports;
  const dot = $("sideDot");
  if (dot) dot.classList.toggle("dim", st !== "running");
  const fm = $("footMeta");
  if (fm) fm.textContent = (server.game || "") + " · " + serverId;
  const sd = $("settingsDump");
  if (sd) sd.textContent = JSON.stringify(server, null, 2);
  const rs = $("resState");
  if (rs) rs.textContent = st.charAt(0).toUpperCase() + st.slice(1);
  const rd = $("resDot");
  if (rd) rd.classList.toggle("dim", st !== "running");
  const rsb = $("resStateBar");
  if (rsb) {
    rsb.style.width = st === "running" ? "100%" : st === "error" ? "100%" : "6%";
    rsb.parentElement.className = "bar " + (st === "running" ? "green" : st === "error" ? "red" : "");
  }
  const mem = (server.env && (server.env.SERVER_MEMORY || server.env.MEMORY)) || "2G";
  const rm = $("resMem");
  if (rm) rm.innerHTML = esc(String(mem)) + " <small>limit</small>";
  const cpu = (server.env && (server.env.CPUS || server.env.CPU)) || "2 vCPU";
  const rc = $("resCpu");
  if (rc) rc.innerHTML = esc(String(cpu)) + " <small>limit</small>";
}

async function loadServer() {
  try {
    server = await fetch("/api/servers/" + encodeURIComponent(serverId), { headers: authHeaders() }).then(async (r) => {
      if (!r.ok) throw new Error("load failed: " + r.status);
      return r.json();
    });
  } catch (e) {
    $("srvTitle").textContent = "Server not found";
    toast("Could not load server: " + e.message, "err");
    return;
  }
  paintServer();
  loadSideServers();
}

async function loadSideServers() {
  try {
    const rows = await api("/api/servers");
    const box = $("sideServers");
    if (!box) return;
    box.innerHTML = rows.slice(0, 10).map((s) =>
      "<a class='navlink" + (s.id === serverId ? " active" : "") + "' href='/manage.html?id=" + encodeURIComponent(s.id) + "' title='" + esc(s.name) + "'>" +
      "<span class='dot" + (s.status === "running" ? "" : " dim") + "' style='margin:0'></span>" +
      "<span style='overflow:hidden;text-overflow:ellipsis;white-space:nowrap'>" + esc(s.name) + "</span></a>"
    ).join("") || "<span class='muted' style='font-size:12px'>No servers</span>";
  } catch { /* noop */ }
}

async function power(act) {
  if ((act === "stop" || act === "kill" || act === "restart") && !window.confirm("Confirm " + act + " this server?")) return;
  const btns = document.querySelectorAll("#powerRow button");
  btns.forEach((b) => { b.disabled = true; });
  try {
    const r = await fetch("/api/servers/" + encodeURIComponent(serverId) + "/" + act, {
      method: "POST", headers: authHeaders(true),
    }).then(async (res) => {
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error((d && d.error) || ("failed: " + res.status));
      return d;
    });
    toast(act + " ok", "ok");
    if (r && r.status && server) {
      server.status = r.status;
      paintServer();
    } else {
      await loadServer();
    }
  } catch (e) { toast(e.message, "err"); }
  finally { btns.forEach((b) => { b.disabled = false; }); }
}

async function deleteServer() {
  if (!window.confirm("Delete this server? The container and all data will be removed. This cannot be undone.")) return;
  try {
    await api("/api/servers/" + encodeURIComponent(serverId), { method: "DELETE" });
    toast("Server deleted", "ok");
    try { localStorage.removeItem("warden_last"); } catch { /* noop */ }
    window.location.href = "/";
  } catch (e) {
    if (e.status === 401) { needLogin(); return; }
    toast(e.message, "err");
  }
}

/* ---- console ---- */
function autoScrollOn() {
  const t = $("autoScrollTgl");
  return !t || t.checked;
}

function printLine(line) {
  const s = String(line);
  if (useTerm && term) { term.writeln(s.replace(/\x1b\[[0-9;]*m/g, "")); return; }
  const pre = $("console-fallback");
  pre.classList.remove("hidden");
  pre.textContent += (pre.textContent ? "\n" : "") + s;
  if (pre.textContent.length > 500000) pre.textContent = pre.textContent.slice(-500000);
  if (autoScrollOn()) pre.scrollTop = pre.scrollHeight;
}

function initTerm() {
  try {
    if (typeof Terminal !== "undefined") {
      term = new Terminal({
        convertEol: true,
        fontSize: 13,
        fontFamily: "ui-monospace, Menlo, Consolas, monospace",
        theme: { background: "#04070d", foreground: "#c9e8d4", cursor: "#3b82f6", selectionBackground: "rgba(59,130,246,.35)" },
      });
      term.open($("console-term"));
      term.onData((d) => {
        if (d.includes("\r") || d.includes("\n")) sendConsole($("consoleInput").value);
      });
      useTerm = true;
      $("console-term").style.padding = "0";
      return;
    }
  } catch { term = null; useTerm = false; }
  $("console-term").classList.add("hidden");
  $("console-fallback").classList.remove("hidden");
}

function connectConsole() {
  if (!serverId) return;
  try { if (ws) ws.close(); } catch { /* noop */ }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  setWsState("connecting…", false);
  let url;
  try {
    url = (window.location.protocol === "https:" ? "wss:" : "ws:") + "//" + window.location.host +
      "/ws/servers/" + encodeURIComponent(serverId) + "/console?token=" + encodeURIComponent(store.token);
  } catch { setWsState("connect failed", false); return; }
  try {
    ws = new WebSocket(url);
  } catch {
    setWsState("connect failed", false);
    return;
  }
  ws.onopen = () => setWsState("connected · live", true);
  ws.onmessage = (ev) => printLine(typeof ev.data === "string" ? ev.data : "(binary)");
  ws.onerror = () => setWsState("error (check login)", false);
  ws.onclose = () => {
    setWsState("disconnected — retrying…", false);
    reconnectTimer = setTimeout(() => { if (document.querySelector("#pane-console.active")) connectConsole(); }, 4000);
  };
}

function sendConsole(text) {
  const cmd = String(text || "").trim();
  if (!cmd) return;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(cmd);
  else toast("Console not connected", "err");
  $("consoleInput").value = "";
}

/* ---- files ---- */
async function listFiles(path) {
  try {
    const q = path ? "?path=" + encodeURIComponent(path) : "";
    const d = await api("/api/servers/" + encodeURIComponent(serverId) + "/files" + q);
    if (d && d.entries) {
      curPath = d.path || "";
      renderFiles(d.entries);
      return;
    }
    if (d && d.type === "file") {
      await openFile(d.path);
      return;
    }
    renderFiles([]);
  } catch (e) {
    if (e.status === 401) { needLogin(); return; }
    toast(e.message, "err");
  }
}

const ICONS = {
  dir: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'/></svg>",
  arc: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z'/><path d='m3.3 7 8.7 5 8.7-5M12 22V12'/></svg>",
  doc: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'/><path d='M14 2v4a2 2 0 0 0 2 2h4'/></svg>",
  img: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='18' height='18' rx='2'/><circle cx='9' cy='9' r='2'/><path d='m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21'/></svg>",
  user: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2'/><circle cx='12' cy='7' r='4'/></svg>",
  up: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12 19V5M5 12l7-7 7 7'/></svg>",
};

function fileTile(f) {
  if (f.type === "dir") return "<span class='fic dir'>" + ICONS.dir + "</span>";
  const n = String(f.name || "").toLowerCase();
  if (/(jar|zip|tgz|gz|tar|rar|7z)$/.test(n)) return "<span class='fic arc'>" + ICONS.arc + "</span>";
  if (/(png|jpg|jpeg|gif|webp|ico|bmp)$/.test(n)) return "<span class='fic img'>" + ICONS.img + "</span>";
  return "<span class='fic doc'>" + ICONS.doc + "</span>";
}

function renderFiles(entries) {
  const crumb = $("crumb");
  const parts = curPath ? curPath.split("/") : [];
  let html = "<button class='ghost small' data-p='' type='button'>root</button>";
  parts.forEach((p, i) => {
    const sub = parts.slice(0, i + 1).join("/");
    html += "<span class='muted'>/</span><button class='ghost small' data-p='" + esc(sub) + "' type='button'>" + esc(p) + "</button>";
  });
  crumb.innerHTML = html;
  const body = $("filesBody");
  const up = curPath ? "<tr><td><a href='#' data-up><span class='fname'><span class='fic up'>" + ICONS.up + "</span>..</span></a></td><td></td><td></td><td></td></tr>" : "";
  body.innerHTML = up + entries.map((f) =>
    "<tr><td><span class='fname'>" + fileTile(f) + (f.type === "dir"
      ? "<a href='#' data-dir='" + esc(f.path) + "'>" + esc(f.name) + "/</a>"
      : "<a href='#' data-file='" + esc(f.path) + "'>" + esc(f.name) + "</a>") + "</span></td>" +
    "<td class='muted'>" + esc(fmtSize(f.size)) + "</td><td class='muted'>" + esc(fmtDate(f.mtime)) + "</td>" +
    "<td><button class='ghost small' data-del='" + esc(f.path) + "' type='button'>Delete</button></td></tr>"
  ).join("") || (up + "<tr><td colspan='4' class='muted'>Empty directory</td></tr>");
}

async function openFile(path) {
  editingPath = path;
  $("editorPath").textContent = path;
  try {
    const res = await fetch("/api/servers/" + encodeURIComponent(serverId) + "/files/download?path=" + encodeURIComponent(path), {
      headers: authHeaders(),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      throw new Error((d && d.error) || ("open failed: " + res.status));
    }
    $("editor").value = await res.text();
  } catch (e) { toast(e.message, "err"); }
}

async function saveFile() {
  if (!editingPath) { toast("Open or create a file first", "err"); return; }
  try {
    await api("/api/servers/" + encodeURIComponent(serverId) + "/files?path=" + encodeURIComponent(editingPath), {
      method: "PUT", body: { content: $("editor").value },
    });
    toast("Saved", "ok");
    listFiles(curPath);
  } catch (e) { toast(e.message, "err"); }
}

/* ---- players ---- */
async function loadPlayers() {
  const body = $("playersBody");
  try {
    const d = await api("/api/servers/" + encodeURIComponent(serverId) + "/players");
    const rows = d.players || [];
    const cp = $("countPlayers");
    if (cp) cp.textContent = String(rows.length);
    body.innerHTML = rows.length ? rows.map((p) => {
      const name = typeof p === "string" ? p : (p.name || p.username || JSON.stringify(p));
      return "<tr><td><span class='fname'><span class='fic user'>" + ICONS.user + "</span>" + esc(name) + "</span></td><td><div class='row'>" +
        "<button class='ghost small' data-kick='" + esc(name) + "' type='button'>Kick</button>" +
        "<button class='ghost small' data-ban='" + esc(name) + "' type='button'>Ban</button>" +
        "<button class='ghost small' data-op='" + esc(name) + "' type='button'>Op</button></div></td></tr>";
    }).join("") : "<tr><td colspan='2' class='muted'>No players online" + (d.mock ? " (mock)" : "") + "</td></tr>";
  } catch (e) {
    if (e.status === 401) { needLogin(); return; }
    body.innerHTML = "<tr><td colspan='2' class='muted'>" + esc(e.message) + "</td></tr>";
  }
}

async function playerAct(kind, player) {
  try {
    await api("/api/servers/" + encodeURIComponent(serverId) + "/players/" + kind, {
      method: "POST", body: { player },
    });
    toast(kind + " sent for " + player, "ok");
    loadPlayers();
  } catch (e) { toast(e.message, "err"); }
}

/* ---- schedules ---- */
async function loadSchedules() {
  try {
    const rows = await api("/api/servers/" + encodeURIComponent(serverId) + "/schedules");
    const el = $("countSched");
    if (el) el.textContent = String(rows.length);
    $("schedBody").innerHTML = rows.length ? rows.map((s) =>
      "<tr><td><b>" + esc(s.name) + "</b></td><td><code class='inline'>" + esc(s.cron) + "</code></td>" +
      "<td><span class='chip'>" + esc(s.action) + "</span></td><td>" + (s.enabled ? "<span class='pill running'>on</span>" : "<span class='pill stopped'>off</span>") + "</td>" +
      "<td><button class='danger small' data-sched='" + esc(s.id) + "' type='button'>Delete</button></td></tr>"
    ).join("") : "<tr><td colspan='5' class='muted'>No schedules — e.g. daily restart <code class='inline'>0 4 * * *</code></td></tr>";
  } catch (e) {
    if (e.status === 401) { needLogin(); return; }
    $("schedBody").innerHTML = "<tr><td colspan='5' class='muted'>" + esc(e.message) + "</td></tr>";
  }
}

async function createSchedule() {
  const action = $("schedAction").value;
  const payload = action === "command" ? { command: $("schedCmd").value.trim() } : null;
  try {
    await api("/api/servers/" + encodeURIComponent(serverId) + "/schedules", {
      method: "POST",
      body: { name: $("schedName").value.trim() || action, cron: $("schedCron").value.trim(), action, payload },
    });
    toast("Schedule created", "ok");
    $("schedName").value = ""; $("schedCron").value = ""; $("schedCmd").value = "";
    loadSchedules();
  } catch (e) { toast(e.message, "err"); }
}

/* ---- backups ---- */
async function downloadBackup(backupId) {
  try {
    const res = await fetch("/api/servers/" + encodeURIComponent(serverId) + "/backups/" + encodeURIComponent(backupId) + "/download", {
      headers: authHeaders(),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      throw new Error((d && d.error) || ("download failed: " + res.status));
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = backupId;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast("Backup download started", "ok");
  } catch (e) {
    if (e.status === 401) { needLogin(); return; }
    toast(e.message, "err");
  }
}

async function loadBackups() {
  try {
    const rows = await api("/api/servers/" + encodeURIComponent(serverId) + "/backups");
    const el = $("countBackups");
    if (el) el.textContent = String(rows.length);
    $("backupBody").innerHTML = rows.length ? rows.map((b) =>
      "<tr><td><b>" + esc(b.name) + "</b></td><td class='muted'>" + esc(fmtSize(b.size)) + "</td><td class='muted'>" + esc(fmtDate(b.createdAt)) + "</td>" +
      "<td><div class='row'><button class='ghost small' data-dl='" + esc(b.id) + "' type='button'>Download</button>" +
      "<button class='ghost small' data-restore='" + esc(b.id) + "' type='button'>Restore</button>" +
      "<button class='danger small' data-bdel='" + esc(b.id) + "' type='button'>Delete</button></div></td></tr>"
    ).join("") : "<tr><td colspan='4' class='muted'>No backups yet</td></tr>";
  } catch (e) {
    if (e.status === 401) { needLogin(); return; }
    $("backupBody").innerHTML = "<tr><td colspan='4' class='muted'>" + esc(e.message) + "</td></tr>";
  }
}

/* ---- tabs & bind ---- */
function bindTabs() {
  $("tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + b.dataset.tab));
    if (b.dataset.tab === "players") loadPlayers();
    if (b.dataset.tab === "files") listFiles(curPath);
    if (b.dataset.tab === "schedules") loadSchedules();
    if (b.dataset.tab === "backups") loadBackups();
  });
}

function bind() {
  bindTabs();
  $("logoutBtn").addEventListener("click", () => {
    store.token = "";
    window.location.href = "/";
  });
  $("powerRow").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (b) power(b.dataset.act);
  });
  const delBtn = $("deleteServerBtn");
  if (delBtn) delBtn.addEventListener("click", deleteServer);
  const delBtn2 = $("deleteServerBtn2");
  if (delBtn2) delBtn2.addEventListener("click", deleteServer);
  $("consoleSend").addEventListener("click", () => sendConsole($("consoleInput").value));
  $("consoleInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendConsole(e.target.value); });
  $("consoleClear").addEventListener("click", () => {
    if (useTerm && term) term.clear();
    $("console-fallback").textContent = "";
  });

  $("crumb").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-p]");
    if (!b) return;
    e.preventDefault();
    editingPath = "";
    listFiles(b.dataset.p);
  });
  $("filesBody").addEventListener("click", (e) => {
    const dir = e.target.closest("[data-dir]");
    const file = e.target.closest("[data-file]");
    const del = e.target.closest("[data-del]");
    const up = e.target.closest("[data-up]");
    if (dir) { e.preventDefault(); listFiles(dir.dataset.dir); return; }
    if (file) { e.preventDefault(); openFile(file.dataset.file); return; }
    if (up) {
      e.preventDefault();
      const parts = curPath.split("/").filter(Boolean);
      parts.pop();
      listFiles(parts.join("/"));
      return;
    }
    if (del) {
      e.preventDefault();
      if (!window.confirm("Delete " + del.dataset.del + "?")) return;
      api("/api/servers/" + encodeURIComponent(serverId) + "/files/delete", {
        method: "POST", body: { path: del.dataset.del },
      }).then(() => { toast("Deleted", "ok"); listFiles(curPath); })
        .catch((err) => toast(err.message, "err"));
    }
  });
  $("saveFileBtn").addEventListener("click", saveFile);
  $("newFileBtn").addEventListener("click", async () => {
    const n = $("newFileName").value.trim();
    if (!n) { toast("Enter a file path first", "err"); return; }
    const full = curPath ? curPath + "/" + n : n;
    editingPath = full;
    $("editorPath").textContent = full;
    $("editor").value = "";
    try {
      await api("/api/servers/" + encodeURIComponent(serverId) + "/files?path=" + encodeURIComponent(full), {
        method: "PUT", body: { content: "" },
      });
      toast("File created", "ok");
      listFiles(curPath);
    } catch (e) { toast(e.message, "err"); }
  });
  $("mkdirBtn").addEventListener("click", async () => {
    const n = $("newFileName").value.trim();
    if (!n) { toast("Enter a directory path first", "err"); return; }
    const full = curPath ? curPath + "/" + n : n;
    try {
      await api("/api/servers/" + encodeURIComponent(serverId) + "/files/mkdir", {
        method: "POST", body: { path: full },
      });
      toast("Directory created", "ok");
      $("newFileName").value = "";
      listFiles(curPath);
    } catch (e) { toast(e.message, "err"); }
  });
  $("renameBtn").addEventListener("click", async () => {
    if (!editingPath) { toast("Open a file first", "err"); return; }
    const to = window.prompt("Rename to:", editingPath);
    if (!to) return;
    try {
      await api("/api/servers/" + encodeURIComponent(serverId) + "/files/rename", {
        method: "POST", body: { from: editingPath, to },
      });
      editingPath = to;
      $("editorPath").textContent = to;
      toast("Renamed", "ok");
      listFiles(curPath);
    } catch (e) { toast(e.message, "err"); }
  });
  $("deleteBtn").addEventListener("click", async () => {
    if (!editingPath) { toast("Open a file first", "err"); return; }
    if (!window.confirm("Delete " + editingPath + "?")) return;
    try {
      await api("/api/servers/" + encodeURIComponent(serverId) + "/files/delete", {
        method: "POST", body: { path: editingPath },
      });
      toast("Deleted", "ok");
      editingPath = "";
      $("editorPath").textContent = "-";
      $("editor").value = "";
      listFiles(curPath);
    } catch (e) { toast(e.message, "err"); }
  });
  $("uploadInput").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    try {
      const res = await fetch("/api/servers/" + encodeURIComponent(serverId) + "/files/upload?path=" + encodeURIComponent(curPath), {
        method: "POST",
        headers: store.token ? { Authorization: "Bearer " + store.token } : {},
        body: fd,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error((d && d.error) || ("upload failed: " + res.status));
      }
      toast("Uploaded", "ok");
      listFiles(curPath);
    } catch (err) { toast(err.message, "err"); }
    e.target.value = "";
  });

  $("playersRefresh").addEventListener("click", loadPlayers);
  $("playersBody").addEventListener("click", (e) => {
    const k = e.target.closest("[data-kick]");
    const b = e.target.closest("[data-ban]");
    const o = e.target.closest("[data-op]");
    if (k) playerAct("kick", k.dataset.kick);
    else if (b) playerAct("ban", b.dataset.ban);
    else if (o) playerAct("op", o.dataset.op);
  });
  $("sayBtn").addEventListener("click", async () => {
    const m = $("sayInput").value.trim();
    if (!m) return;
    try {
      await api("/api/servers/" + encodeURIComponent(serverId) + "/players/say", { method: "POST", body: { message: m } });
      $("sayInput").value = "";
      toast("Broadcast sent", "ok");
    } catch (e) { toast(e.message, "err"); }
  });
  $("cmdBtn").addEventListener("click", async () => {
    const c = $("cmdInput").value.trim();
    if (!c) return;
    try {
      const r = await api("/api/servers/" + encodeURIComponent(serverId) + "/players/command", { method: "POST", body: { command: c } });
      $("cmdInput").value = "";
      toast("Command sent" + (r && r.response ? ": " + String(r.response).slice(0, 120) : ""), "ok");
    } catch (e) { toast(e.message, "err"); }
  });

  $("schedCreate").addEventListener("click", createSchedule);
  $("schedBody").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-sched]");
    if (!b) return;
    if (!window.confirm("Delete this schedule?")) return;
    try {
      await api("/api/servers/" + encodeURIComponent(serverId) + "/schedules/" + encodeURIComponent(b.dataset.sched), { method: "DELETE" });
      toast("Schedule deleted", "ok");
      loadSchedules();
    } catch (err) { toast(err.message, "err"); }
  });

  $("backupCreate").addEventListener("click", async () => {
    const btn = $("backupCreate");
    try {
      btn.disabled = true;
      btn.textContent = "Creating…";
      await api("/api/servers/" + encodeURIComponent(serverId) + "/backups", {
        method: "POST", body: { name: $("backupName").value.trim() || "manual" },
      });
      $("backupName").value = "";
      toast("Backup created", "ok");
      loadBackups();
    } catch (e) { toast(e.message, "err"); }
    finally { btn.disabled = false; btn.textContent = "Create backup"; }
  });
  $("backupRefresh").addEventListener("click", loadBackups);
  const cp = $("copyIpBtn");
  if (cp) cp.addEventListener("click", () => {
    const v = serverId || window.location.host;
    if (navigator.clipboard) navigator.clipboard.writeText(v).then(() => toast("Copied: " + v, "ok")).catch(() => toast(v, ""));
    else window.prompt("Copy:", v);
  });
  const nt = $("navToggle");
  if (nt) nt.addEventListener("click", () => document.body.classList.toggle("navopen"));
  const ov = $("navOverlay");
  if (ov) ov.addEventListener("click", () => document.body.classList.remove("navopen"));
  $("backupBody").addEventListener("click", async (e) => {
    const dl = e.target.closest("[data-dl]");
    const r = e.target.closest("[data-restore]");
    const d = e.target.closest("[data-bdel]");
    if (dl) {
      e.preventDefault();
      downloadBackup(dl.dataset.dl);
    } else if (r) {
      if (!window.confirm("Restore backup " + r.dataset.restore + "? Current files will be overwritten.")) return;
      try {
        await api("/api/servers/" + encodeURIComponent(serverId) + "/backups/" + encodeURIComponent(r.dataset.restore) + "/restore", { method: "POST" });
        toast("Backup restored", "ok");
      } catch (err) { toast(err.message, "err"); }
    } else if (d) {
      if (!window.confirm("Delete backup " + d.dataset.bdel + "?")) return;
      try {
        await api("/api/servers/" + encodeURIComponent(serverId) + "/backups/" + encodeURIComponent(d.dataset.bdel), { method: "DELETE" });
        toast("Backup deleted", "ok");
        loadBackups();
      } catch (err) { toast(err.message, "err"); }
    }
  });
}

async function init() {
  if (!serverId) {
    $("srvTitle").textContent = "Missing ?id=";
    toast("Missing server id", "err");
    return;
  }
  if (!store.token) { needLogin(); return; }
  try {
    const me = await api("/api/auth/me");
    const ub = $("userbox");
    if (ub) ub.textContent = me.username + " · " + me.role;
    const ta = $("topAva");
    if (ta) ta.textContent = (me.username || "?")[0].toUpperCase();
    const sa = $("sideAva");
    if (sa) sa.textContent = (me.username || "?")[0].toUpperCase();
    const sn = $("sideUname");
    if (sn) sn.textContent = me.username || "—";
  } catch { needLogin(); return; }
  bind();
  initTerm();
  await loadServer();
  connectConsole();
  listFiles("");
  loadPlayers();
  loadSchedules();
  loadBackups();
}

document.addEventListener("DOMContentLoaded", init);
