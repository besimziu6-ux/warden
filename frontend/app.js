"use strict";

const $ = (id) => document.getElementById(id);
const store = {
  get token() { return localStorage.getItem("warden_token") || localStorage.getItem("gp_token") || ""; },
  set token(v) {
    if (v) localStorage.setItem("warden_token", v);
    else { localStorage.removeItem("warden_token"); localStorage.removeItem("gp_token"); }
  },
  get user() {
    try { return JSON.parse(localStorage.getItem("warden_user") || localStorage.getItem("gp_user") || "null"); }
    catch { return null; }
  },
  set user(v) {
    if (v) localStorage.setItem("warden_user", JSON.stringify(v));
    else { localStorage.removeItem("warden_user"); localStorage.removeItem("gp_user"); }
  },
  get lastServer() { return localStorage.getItem("warden_last") || localStorage.getItem("gp_last") || ""; },
  set lastServer(v) {
    if (v) localStorage.setItem("warden_last", v);
    else { localStorage.removeItem("warden_last"); localStorage.removeItem("gp_last"); }
  },
};

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

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (store.token) h.Authorization = "Bearer " + store.token;
  return h;
}

async function api(path, opts) {
  const res = await fetch(path, {
    method: (opts && opts.method) || "GET",
    headers: authHeaders(),
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
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

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function setAuthed(user) {
  const authed = !!user;
  $("authedLayout").style.display = authed ? "" : "none";
  $("authView").style.display = authed ? "none" : "";
  if (!authed) return;
  const uname = user.username || "?";
  const av = $("sideAva");
  if (av) av.textContent = uname[0].toUpperCase();
  const ab = $("avatarBtn");
  if (ab) ab.textContent = uname[0].toUpperCase();
  const su = $("sideUname");
  if (su) su.textContent = uname;
  const sr = $("sideRole");
  if (sr) sr.textContent = user.role || "user";
  checkNode();
  loadServers();
  if (user.role === "admin") loadUsers();
  else {
    $("usersCard").classList.add("hidden");
    const su2 = $("statUsers");
    if (su2) su2.textContent = "–";
  }
}

async function checkNode() {
  try {
    const h = await fetch("/health").then((r) => r.json());
    const t = $("sideNodeText");
    if (t) t.textContent = "Local node · " + (h.mock ? "mock driver" : "docker live");
    const d = $("sideDot");
    if (d) d.classList.toggle("dim", false);
  } catch {
    const t = $("sideNodeText");
    if (t) t.textContent = "Local node · unreachable";
  }
}

async function loadUsers() {
  try {
    const rows = await api("/api/users");
    $("usersCard").classList.remove("hidden");
    const su = $("statUsers");
    if (su) su.textContent = String(rows.length);
    $("usersBody").innerHTML = rows.map((u) =>
      "<tr><td><b>" + esc(u.username) + "</b></td><td><span class='chip'>" + esc(u.role) + "</span></td><td><code class='inline'>" +
      esc(u.id) + "</code></td><td class='muted'>" + esc(u.createdAt || "") + "</td></tr>"
    ).join("") || "<tr><td colspan='4' class='muted'>No users</td></tr>";
  } catch (e) {
    $("usersCard").classList.add("hidden");
  }
}

let cachedServers = [];

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

function statusClass(st) {
  if (st === "running") return "is-running";
  if (st === "error" || st === "failed") return "is-error";
  if (st === "starting" || st === "restarting") return "is-transition";
  return "";
}

function fmtPort(s) {
  const p = s.ports && s.ports[0];
  if (p && (p.host || p.container)) return String(p.host || p.container);
  const env = s.env || {};
  return String(env.SERVER_PORT || env.PORT || s.port || "");
}

function serverRow(s) {
  const st = s.status || "created";
  const game = s.game || "";
  const mem = (s.env && (s.env.SERVER_MEMORY || s.env.MEMORY)) || "";
  const port = fmtPort(s);
  return "<a class='server-row " + statusClass(st) + "' href='/manage.html?id=" + encodeURIComponent(s.id) + "'>" +
    "<div class='srv-icon " + avatarClass(game) + "'>" + esc(initials(s.name)) + "</div>" +
    "<div class='srv-main'><b>" + esc(s.name) + "</b>" +
    "<span class='egg'>" + esc(game) + " · <code class='inline'>" + esc(s.id.slice(0, 8)) + "</code></span></div>" +
    "<div class='srv-meta'>" +
    (mem ? "<span class='chip'>" + esc(String(mem)) + "</span>" : "") +
    (port ? "<span class='chip'>:" + esc(String(port)) + "</span>" : "") +
    "</div>" +
    "<div class='srv-right'><span class='pill " + esc(st) + "'>" + esc(st) + "</span>" +
    "<button class='qbtn' data-act='start' data-id='" + esc(s.id) + "' type='button' title='Start' aria-label='Start " + esc(s.name) + "'>" +
    "<svg viewBox='0 0 24 24' fill='currentColor'><path d='M8 5v14l11-7z'/></svg></button>" +
    "<button class='qbtn' data-act='stop' data-id='" + esc(s.id) + "' type='button' title='Stop' aria-label='Stop " + esc(s.name) + "'>" +
    "<svg viewBox='0 0 24 24' fill='currentColor'><rect x='6' y='6' width='12' height='12' rx='2'/></svg></button>" +
    "<span class='chev'>›</span></div></a>";
}

function renderStats() {
  const total = cachedServers.length;
  const running = cachedServers.filter((s) => s.status === "running").length;
  const stopped = cachedServers.filter((s) => s.status === "stopped" || s.status === "created" || s.status === "killed").length;
  $("statTotal").textContent = String(total);
  $("statRunning").textContent = String(running);
  $("statStopped").textContent = String(stopped);
  $("serverCount").textContent = total
    ? total + " server" + (total === 1 ? "" : "s") + " · " + running + " running"
    : "Your game servers at a glance.";
  const sub = $("serverSub");
  if (sub) sub.textContent = total ? total + " total" : "";
  const side = $("sideServers");
  if (side) {
    side.innerHTML = total ? cachedServers.slice(0, 8).map((s) =>
      "<a class='navlink' href='/manage.html?id=" + encodeURIComponent(s.id) + "' title='" + esc(s.name) + "'>" +
      "<span class='dot" + (s.status === "running" ? "" : " dim") + "' style='margin:0'></span>" +
      "<span style='overflow:hidden;text-overflow:ellipsis;white-space:nowrap'>" + esc(s.name) + "</span></a>"
    ).join("") : "<span class='muted' style='font-size:12px;padding:0 10px'>No servers yet</span>";
  }
}

function renderServerList() {
  const list = $("serverList");
  const q = ($("serverSearch") && $("serverSearch").value || "").trim().toLowerCase();
  const rows = !q ? cachedServers : cachedServers.filter((s) =>
    String(s.name || "").toLowerCase().includes(q) || String(s.game || "").toLowerCase().includes(q) || String(s.id || "").toLowerCase().includes(q));
  renderStats();
  if (q) $("serverCount").textContent += " · " + rows.length + " match" + (rows.length === 1 ? "" : "es");
  list.innerHTML = rows.length ? rows.map(serverRow).join("")
    : "<div class='empty'><div class='big'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8'><rect x='2' y='3' width='20' height='7' rx='2'/><rect x='2' y='14' width='20' height='7' rx='2'/></svg></div><b>" +
      (cachedServers.length ? "No servers match" : "No servers yet") + "</b><p class='muted' style='margin:4px 0 14px'>" +
      (cachedServers.length ? "Try a different search." : "Spin up your first game server to get started.") + "</p>" +
      (cachedServers.length ? "" : "<button class='small' type='button' id='emptyCreate'>+ Create server</button>") + "</div>";
  const ec = $("emptyCreate");
  if (ec) ec.addEventListener("click", (e) => { e.stopPropagation(); openWizard(); });
}

async function loadServers() {
  const list = $("serverList");
  list.innerHTML = "<div class='skel-row'></div><div class='skel-row'></div><div class='skel-row'></div>";
  try {
    const rows = await api("/api/servers");
    cachedServers = Array.isArray(rows) ? rows : [];
    renderServerList();
  } catch (e) {
    if (e.status === 401) { logout(); return; }
    list.innerHTML = "<div class='empty'><b>Failed to load servers</b><p class='muted'>" + esc(e.message) + "</p></div>";
  }
}

async function power(id, act) {
  if ((act === "stop" || act === "kill") && !window.confirm("Confirm " + act + " this server?")) return;
  try {
    await api("/api/servers/" + encodeURIComponent(id) + "/" + act, { method: "POST" });
    toast(act + " sent", "ok");
    loadServers();
  } catch (e) { toast(e.message, "err"); }
}

function logout() {
  store.token = "";
  store.user = null;
  $("authedLayout").style.display = "none";
  $("authView").style.display = "";
}

/* ---- create wizard ---- */
const wiz = { step: 1, games: [], sel: null, env: {} };

function openWizard() {
  wiz.step = 1;
  renderWiz();
  $("wizardBack").classList.add("open");
  document.body.style.overflow = "hidden";
  loadGames();
}
function closeWizard() {
  $("wizardBack").classList.remove("open");
  document.body.style.overflow = "";
}

function renderWiz() {
  $("wstep1").classList.toggle("hidden", wiz.step !== 1);
  $("wstep2").classList.toggle("hidden", wiz.step !== 2);
  $("wstep3").classList.toggle("hidden", wiz.step !== 3);
  $("st1").classList.toggle("on", wiz.step === 1);
  $("st2").classList.toggle("on", wiz.step === 2);
  $("st3").classList.toggle("on", wiz.step === 3);
  $("wBack").disabled = wiz.step === 1;
  $("wNext").textContent = wiz.step === 3 ? "Create server" : "Next";
  if (wiz.step === 3) renderReview();
}

async function loadGames() {
  const grid = $("gameGrid");
  try {
    const games = await api("/api/games");
    wiz.games = games;
    if (!games.length) { grid.innerHTML = "<p class='muted'>No games available</p>"; return; }
    if (!wiz.sel || !games.find((g) => g.id === wiz.sel)) wiz.sel = games[0].id;
    grid.innerHTML = games.map((g) =>
      "<div class='gamecard" + (wiz.sel === g.id ? " sel" : "") + "' data-id='" + esc(g.id) + "' tabindex='0' role='option' aria-selected='" + (wiz.sel === g.id) + "'>" +
      "<b><span class='gicon'>" + esc(initials(g.name || g.id)) + "</span>" + esc(g.name || g.id) + "</b><code>" + esc(g.id) + "</code>" +
      "<div class='gimg'>" + esc((g.image || "")) + "</div></div>"
    ).join("");
  } catch (e) {
    grid.innerHTML = "<p class='muted'>Failed to load games: " + esc(e.message) + "</p>";
  }
}

function selectedEgg() { return wiz.games.find((g) => g.id === wiz.sel) || null; }

function renderEnvForm() {
  const egg = selectedEgg();
  const rows = $("envRows");
  if (!egg) { rows.innerHTML = ""; return; }
  const merged = Object.assign({}, egg.env || {}, wiz.env);
  wiz.env = merged;
  $("eggMeta").innerHTML = "Image <code class='inline'>" + esc(egg.image || "") + "</code> · startup <code class='inline'>" + esc(egg.startup || "") + "</code>";
  $("portsBox").innerHTML = "Ports: <code class='inline'>" + esc((egg.ports || []).map((p) => p.container + "/" + (p.protocol || "tcp")).join(", ") || "none") + "</code>" +
    " · Limits: <code class='inline'>2G RAM / 2 CPU / 256 pids</code>";
  rows.innerHTML = "";
  Object.keys(merged).forEach((k) => addEnvRow(k, merged[k]));
}

function addEnvRow(k, v) {
  const rows = $("envRows");
  const div = document.createElement("div");
  div.className = "envrow";
  const kInput = document.createElement("input");
  kInput.placeholder = "KEY";
  kInput.value = k || "";
  kInput.setAttribute("aria-label", "Variable name");
  const vInput = document.createElement("input");
  vInput.placeholder = "value";
  vInput.value = v || "";
  vInput.setAttribute("aria-label", "Variable value");
  const btn = document.createElement("button");
  btn.className = "ghost small";
  btn.type = "button";
  btn.textContent = "✕";
  btn.setAttribute("aria-label", "Remove variable");
  btn.addEventListener("click", () => div.remove());
  div.append(kInput, vInput, btn);
  rows.appendChild(div);
}

function readEnvForm() {
  const out = {};
  document.querySelectorAll("#envRows .envrow").forEach((r) => {
    const inputs = r.querySelectorAll("input");
    const k = (inputs[0].value || "").trim();
    const v = inputs[1].value;
    if (k) out[k] = v;
  });
  return out;
}

function renderReview() {
  const name = $("srvName").value.trim() || "(unnamed)";
  wiz.env = readEnvForm();
  $("reviewBox").textContent = JSON.stringify({ game: wiz.sel, name, env: wiz.env }, null, 2);
}

async function wizNext() {
  if (wiz.step === 1) {
    if (!wiz.sel) { toast("Pick a game first", "err"); return; }
    wiz.step = 2;
    renderWiz();
    renderEnvForm();
    return;
  }
  if (wiz.step === 2) {
    wiz.env = readEnvForm();
    const name = $("srvName").value.trim();
    if (!name) { toast("Server name is required", "err"); $("srvName").focus(); return; }
    wiz.step = 3;
    renderWiz();
    return;
  }
  const name = $("srvName").value.trim();
  try {
    $("wNext").disabled = true;
    $("wNext").textContent = "Creating…";
    const srv = await api("/api/servers", { method: "POST", body: { game: wiz.sel, name, env: wiz.env } });
    toast("Server created", "ok");
    store.lastServer = srv.id;
    closeWizard();
    $("srvName").value = "";
    wiz.env = {};
    loadServers();
    window.location.href = "/manage.html?id=" + encodeURIComponent(srv.id);
  } catch (e) {
    toast(e.message, "err");
  } finally {
    $("wNext").disabled = false;
    renderWiz();
  }
}

function bindAuthTabs() {
  const tl = $("tabLogin");
  const tr = $("tabRegister");
  if (!tl || !tr) return;
  const show = (which) => {
    const login = which === "login";
    tl.classList.toggle("active", login);
    tr.classList.toggle("active", !login);
    $("paneLogin").classList.toggle("hidden", !login);
    $("paneRegister").classList.toggle("hidden", login);
  };
  tl.addEventListener("click", () => show("login"));
  tr.addEventListener("click", () => show("register"));
}

function doLogout() {
  logout();
  toast("Logged out", "ok");
}

function bind() {
  bindAuthTabs();
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    try {
      if (btn) { btn.disabled = true; btn.textContent = "Logging in…"; }
      const r = await api("/api/auth/login", { method: "POST", body: { username: $("loginUser").value.trim(), password: $("loginPass").value } });
      store.token = r.token; store.user = r.user;
      setAuthed(r.user);
      toast("Welcome back, " + r.user.username, "ok");
    } catch (err) { toast(err.message, "err"); }
    finally { if (btn) { btn.disabled = false; btn.textContent = "Log in"; } }
  });
  $("registerForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    try {
      if (btn) { btn.disabled = true; btn.textContent = "Creating…"; }
      const r = await api("/api/auth/register", { method: "POST", body: { username: $("regUser").value.trim(), password: $("regPass").value } });
      store.token = r.token; store.user = r.user;
      setAuthed(r.user);
      toast("Account created", "ok");
    } catch (err) { toast(err.message, "err"); }
    finally { if (btn) { btn.disabled = false; btn.textContent = "Create account"; } }
  });
  $("logoutBtn").addEventListener("click", doLogout);
  const ls = $("logoutBtnSide");
  if (ls) ls.addEventListener("click", doLogout);
  const av = $("avatarBtn");
  if (av) av.addEventListener("click", () => toast(store.user ? store.user.username + " (" + store.user.role + ")" : "Not logged in", ""));
  $("refreshBtn").addEventListener("click", loadServers);
  const r2 = $("refreshBtn2");
  if (r2) r2.addEventListener("click", loadServers);
  $("openWizardBtn").addEventListener("click", openWizard);
  $("wClose").addEventListener("click", closeWizard);
  const wx = $("wCloseX");
  if (wx) wx.addEventListener("click", closeWizard);
  $("wizardBack").addEventListener("click", (e) => { if (e.target.id === "wizardBack") closeWizard(); });
  $("wBack").addEventListener("click", () => { if (wiz.step > 1) { wiz.step -= 1; renderWiz(); if (wiz.step === 2) renderEnvForm(); } });
  $("wNext").addEventListener("click", wizNext);
  $("addEnvBtn").addEventListener("click", () => addEnvRow("", ""));
  $("gameGrid").addEventListener("click", (e) => {
    const c = e.target.closest(".gamecard");
    if (!c) return;
    wiz.sel = c.dataset.id;
    wiz.env = {};
    document.querySelectorAll(".gamecard").forEach((el) => el.classList.toggle("sel", el.dataset.id === wiz.sel));
  });
  $("gameGrid").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const c = e.target.closest(".gamecard");
    if (!c) return;
    e.preventDefault();
    wiz.sel = c.dataset.id;
    wiz.env = {};
    document.querySelectorAll(".gamecard").forEach((el) => el.classList.toggle("sel", el.dataset.id === wiz.sel));
  });
  $("serverList").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (b) {
      e.preventDefault();
      e.stopPropagation();
      power(b.dataset.id, b.dataset.act);
    }
  });
  const ss = $("serverSearch");
  if (ss) ss.addEventListener("input", renderServerList);
  const nt = $("navToggle");
  const overlay = $("navOverlay");
  if (nt) nt.addEventListener("click", () => document.body.classList.toggle("navopen"));
  if (overlay) overlay.addEventListener("click", () => document.body.classList.remove("navopen"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if ($("wizardBack").classList.contains("open")) closeWizard();
      document.body.classList.remove("navopen");
    }
  });
}

async function init() {
  bind();
  try {
    const h = await fetch("/health").then((r) => r.json()).catch(() => null);
    const av = $("authVer");
    if (av && h) av.textContent = "warden · " + (h.mock ? "mock driver" : "docker live") + " · " + new Date(h.time || Date.now()).toLocaleDateString();
  } catch { /* noop */ }
  if (!store.token) { setAuthed(null); $("authedLayout").style.display = "none"; $("authView").style.display = ""; return; }
  try {
    const me = await api("/api/auth/me");
    store.user = me;
    setAuthed(me);
  } catch {
    logout();
    $("authedLayout").style.display = "none";
    $("authView").style.display = "";
  }
}

document.addEventListener("DOMContentLoaded", init);
