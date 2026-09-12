"use strict";

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(window.location.search);
const serverId = qs.get("id") || "";

const store = {
  get token() { return localStorage.getItem("gp_token") || ""; },
  set token(v) { v ? localStorage.setItem("gp_token", v) : localStorage.removeItem("gp_token"); },
};

let server = null;
let curPath = "";
let editingPath = "";
let ws = null;
let term = null;
let useTerm = false;

function toast(msg, kind) {
  const box = $("toast");
  if (!box) return;
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = String(msg);
  box.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
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
  $("srvTitle").textContent = server.name || serverId;
  const st = $("srvStatus");
  st.textContent = server.status || "created";
  st.className = "badge " + (server.status || "created");
  $("srvMeta").textContent = (server.game || "") + " · " + serverId;
  $("settingsDump").textContent = JSON.stringify(server, null, 2);
}

async function power(act) {
  try {
    const r = await fetch("/api/servers/" + encodeURIComponent(serverId) + "/" + act, {
      method: "POST", headers: authHeaders(true),
    }).then(async (res) => {
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error((d && d.error) || ("failed: " + res.status));
      return d;
    });
    toast(act + " ok", "ok");
    if (r && r.status) {
      server.status = r.status;
      const st = $("srvStatus");
      st.textContent = r.status;
      st.className = "badge " + r.status;
    }
  } catch (e) { toast(e.message, "err"); }
}

/* ---- console ---- */
function printLine(line) {
  const s = String(line);
  if (useTerm && term) { term.writeln(s.replace(/\x1b\[[0-9;]*m/g, "")); return; }
  const pre = $("console-fallback");
  pre.classList.remove("hidden");
  pre.textContent += (pre.textContent ? "\n" : "") + s;
  pre.scrollTop = pre.scrollHeight;
}

function initTerm() {
  try {
    if (typeof Terminal !== "undefined") {
      term = new Terminal({ convertEol: true, fontSize: 13, theme: { background: "#0a0c10" } });
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
  $("wsState").textContent = "connecting...";
  let url;
  try {
    url = (window.location.protocol === "https:" ? "wss:" : "ws:") + "//" + window.location.host +
      "/ws/servers/" + encodeURIComponent(serverId) + "/console?token=" + encodeURIComponent(store.token);
  } catch { $("wsState").textContent = "connect failed"; return; }
  try {
    ws = new WebSocket(url);
  } catch {
    $("wsState").textContent = "connect failed";
    return;
  }
  ws.onopen = () => { $("wsState").textContent = "connected"; };
  ws.onmessage = (ev) => printLine(typeof ev.data === "string" ? ev.data : "(binary)");
  ws.onerror = () => { $("wsState").textContent = "error (check login)"; };
  ws.onclose = () => { $("wsState").textContent = "disconnected"; };
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

function renderFiles(entries) {
  const crumb = $("crumb");
  const parts = curPath ? curPath.split("/") : [];
  let html = "<button class='ghost small' data-p=''>root</button>";
  parts.forEach((p, i) => {
    const sub = parts.slice(0, i + 1).join("/");
    html += "<span class='muted'>/</span><button class='ghost small' data-p='" + esc(sub) + "'>" + esc(p) + "</button>";
  });
  crumb.innerHTML = html;
  const body = $("filesBody");
  const up = curPath ? "<tr><td><a href='#' data-up>..</a></td><td>dir</td><td></td><td></td></tr>" : "";
  body.innerHTML = up + entries.map((f) =>
    "<tr><td>" + (f.type === "dir"
      ? "<a href='#' data-dir='" + esc(f.path) + "'>" + esc(f.name) + "/</a>"
      : "<a href='#' data-file='" + esc(f.path) + "'>" + esc(f.name) + "</a>") + "</td>" +
    "<td>" + esc(f.type) + "</td><td>" + (f.size == null ? "-" : esc(f.size)) + "</td>" +
    "<td><button class='ghost small' data-del='" + esc(f.path) + "'>del</button></td></tr>"
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
    body.innerHTML = rows.length ? rows.map((p) => {
      const name = typeof p === "string" ? p : (p.name || p.username || JSON.stringify(p));
      return "<tr><td>" + esc(name) + "</td><td><div class='row'>" +
        "<button class='ghost small' data-kick='" + esc(name) + "'>Kick</button>" +
        "<button class='ghost small' data-ban='" + esc(name) + "'>Ban</button>" +
        "<button class='ghost small' data-op='" + esc(name) + "'>Op</button></div></td></tr>";
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
    $("schedBody").innerHTML = rows.length ? rows.map((s) =>
      "<tr><td>" + esc(s.name) + "</td><td><code class='inline'>" + esc(s.cron) + "</code></td>" +
      "<td>" + esc(s.action) + "</td><td>" + (s.enabled ? "yes" : "no") + "</td>" +
      "<td><button class='danger small' data-sched='" + esc(s.id) + "'>Delete</button></td></tr>"
    ).join("") : "<tr><td colspan='5' class='muted'>No schedules</td></tr>";
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
async function loadBackups() {
  try {
    const rows = await api("/api/servers/" + encodeURIComponent(serverId) + "/backups");
    $("backupBody").innerHTML = rows.length ? rows.map((b) =>
      "<tr><td>" + esc(b.name) + "</td><td>" + esc(b.size) + "</td><td>" + esc(b.createdAt || "") + "</td>" +
      "<td><div class='row'><button class='ghost small' data-restore='" + esc(b.id) + "'>Restore</button>" +
      "<button class='danger small' data-bdel='" + esc(b.id) + "'>Delete</button></div></td></tr>"
    ).join("") : "<tr><td colspan='4' class='muted'>No backups</td></tr>";
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
      toast("Command sent" + (r && r.output ? ": " + String(r.output).slice(0, 120) : ""), "ok");
    } catch (e) { toast(e.message, "err"); }
  });

  $("schedCreate").addEventListener("click", createSchedule);
  $("schedBody").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-sched]");
    if (!b) return;
    try {
      await api("/api/servers/" + encodeURIComponent(serverId) + "/schedules/" + encodeURIComponent(b.dataset.sched), { method: "DELETE" });
      toast("Schedule deleted", "ok");
      loadSchedules();
    } catch (err) { toast(err.message, "err"); }
  });

  $("backupCreate").addEventListener("click", async () => {
    try {
      await api("/api/servers/" + encodeURIComponent(serverId) + "/backups", {
        method: "POST", body: { name: $("backupName").value.trim() || "manual" },
      });
      $("backupName").value = "";
      toast("Backup created", "ok");
      loadBackups();
    } catch (e) { toast(e.message, "err"); }
  });
  $("backupRefresh").addEventListener("click", loadBackups);
  $("backupBody").addEventListener("click", async (e) => {
    const r = e.target.closest("[data-restore]");
    const d = e.target.closest("[data-bdel]");
    if (r) {
      try {
        await api("/api/servers/" + encodeURIComponent(serverId) + "/backups/" + encodeURIComponent(r.dataset.restore) + "/restore", { method: "POST" });
        toast("Backup restored", "ok");
      } catch (err) { toast(err.message, "err"); }
    } else if (d) {
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
    if (ub) ub.textContent = me.username + " (" + me.role + ")";
  } catch { needLogin(); return; }
  bind();
  initTerm();
  await loadServer();
  connectConsole();
  listFiles("");
}

document.addEventListener("DOMContentLoaded", init);
