"use strict";

const $ = (id) => document.getElementById(id);
const store = {
  get token() { return localStorage.getItem("gp_token") || ""; },
  set token(v) { v ? localStorage.setItem("gp_token", v) : localStorage.removeItem("gp_token"); },
  get user() { try { return JSON.parse(localStorage.getItem("gp_user") || "null"); } catch { return null; } },
  set user(v) { v ? localStorage.setItem("gp_user", JSON.stringify(v)) : localStorage.removeItem("gp_user"); },
};

function toast(msg, kind) {
  const box = $("toast");
  if (!box) return;
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = String(msg);
  box.appendChild(el);
  setTimeout(() => el.remove(), 4500);
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
  $("authView").classList.toggle("hidden", authed);
  $("mainView").classList.toggle("hidden", !authed);
  $("logoutBtn").classList.toggle("hidden", !authed);
  $("userbox").textContent = authed ? (user.username + " (" + user.role + ")") : "";
  if (authed) {
    loadServers();
    if (user.role === "admin") loadUsers();
    else $("usersCard").classList.add("hidden");
  }
}

async function loadUsers() {
  try {
    const rows = await api("/api/users");
    $("usersCard").classList.remove("hidden");
    $("usersBody").innerHTML = rows.map((u) =>
      "<tr><td>" + esc(u.username) + "</td><td>" + esc(u.role) + "</td><td><code class='inline'>" +
      esc(u.id) + "</code></td><td>" + esc(u.createdAt || "") + "</td></tr>"
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

function serverCard(s) {
  const st = s.status || "created";
  const game = s.game || "";
  const env = s.env || {};
  const mem = env.SERVER_MEMORY || env.MEMORY || s.memory || "";
  const port = (s.ports && s.ports[0] && (s.ports[0].host || s.ports[0].container)) || env.SERVER_PORT || s.port || "";
  const chips = [game ? "<span class='chip'>" + esc(game) + "</span>" : "",
    mem ? "<span class='chip'>" + esc(String(mem)) + " RAM</span>" : "",
    port ? "<span class='chip'>:" + esc(String(port)) + "</span>" : ""].join("");
  return "<div class='srv'>" +
    "<div class='srv-top'><div class='avatar'>" + esc(initials(s.name)) + "</div>" +
    "<div class='srv-title'><b>" + esc(s.name) + "</b><span>" + esc(game) + "</span></div>" +
    "<span class='badge " + esc(st) + "'>" + esc(st) + "</span></div>" +
    "<div class='srv-meta'><code class='inline'>" + esc(s.id) + "</code></div>" +
    (chips ? "<div class='chips'>" + chips + "</div>" : "") +
    "<div class='srv-actions'><a class='btn small' href='/manage.html?id=" + encodeURIComponent(s.id) + "'>Manage</a>" +
    "<button class='ghost small' data-act='start' data-id='" + esc(s.id) + "'>Start</button>" +
    "<button class='ghost small' data-act='stop' data-id='" + esc(s.id) + "'>Stop</button>" +
    "<button class='ghost small iconbtn' data-copy='" + esc(s.id) + "' title='Copy server ID'>Copy</button></div></div>";
}

function renderServerList() {
  const list = $("serverList");
  const q = ($("serverSearch") && $("serverSearch").value || "").trim().toLowerCase();
  const rows = !q ? cachedServers : cachedServers.filter((s) =>
    String(s.name || "").toLowerCase().includes(q) || String(s.game || "").toLowerCase().includes(q) || String(s.id || "").toLowerCase().includes(q));
  $("serverCount").textContent = cachedServers.length + " server(s)" + (q ? " · " + rows.length + " match" : "");
  list.innerHTML = rows.length ? rows.map(serverCard).join("")
    : "<div class='empty'><div class='big'>&#127918;</div><b>No servers found</b><p class='muted'>Create your first server to get started.</p></div>";
}

async function loadServers() {
  const list = $("serverList");
  list.innerHTML = "<div class='skel'></div><div class='skel'></div><div class='skel'></div>";
  try {
    const rows = await api("/api/servers");
    cachedServers = rows || [];
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
  setAuthed(null);
}

/* ---- create wizard ---- */
const wiz = { step: 1, games: [], sel: null, env: {} };

function openWizard() {
  wiz.step = 1;
  renderWiz();
  $("wizardBack").classList.add("open");
  loadGames();
}
function closeWizard() { $("wizardBack").classList.remove("open"); }

function renderWiz() {
  $("wstep1").classList.toggle("hidden", wiz.step !== 1);
  $("wstep2").classList.toggle("hidden", wiz.step !== 2);
  $("wstep3").classList.toggle("hidden", wiz.step !== 3);
  $("st1").classList.toggle("on", wiz.step === 1);
  $("st2").classList.toggle("on", wiz.step === 2);
  $("st3").classList.toggle("on", wiz.step === 3);
  $("wBack").disabled = wiz.step === 1;
  $("wNext").textContent = wiz.step === 3 ? "Create" : "Next";
  if (wiz.step === 3) renderReview();
}

async function loadGames() {
  const grid = $("gameGrid");
  try {
    const games = await api("/api/games");
    wiz.games = games;
    if (!games.length) { grid.innerHTML = "<p class='muted'>No games available</p>"; return; }
    if (!wiz.sel) wiz.sel = games[0].id;
    grid.innerHTML = games.map((g) =>
      "<div class='gamecard" + (wiz.sel === g.id ? " sel" : "") + "' data-id='" + esc(g.id) + "' tabindex='0'>" +
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
  $("eggMeta").innerHTML = "Image <code class='inline'>" + esc(egg.image || "") + "</code> &middot; startup <code class='inline'>" + esc(egg.startup || "") + "</code>";
  $("portsBox").innerHTML = "Ports: " + esc((egg.ports || []).map((p) => p.container + "/" + p.protocol).join(", ") || "none") +
    "<br>Tip: memory is <code class='inline'>SERVER_MEMORY</code> where applicable (e.g. 2G, 4G).";
  rows.innerHTML = "";
  Object.keys(merged).forEach((k) => addEnvRow(k, merged[k]));
}

function addEnvRow(k, v) {
  const rows = $("envRows");
  const div = document.createElement("div");
  div.className = "envrow";
  div.innerHTML = "<input placeholder='KEY' value='" + esc(k || "") + "' data-k>" +
    "<input placeholder='value' value='" + esc(v || "") + "' data-v>" +
    "<button class='ghost small' type='button'>x</button>";
  div.querySelector("button").addEventListener("click", () => div.remove());
  rows.appendChild(div);
}

function readEnvForm() {
  const out = {};
  document.querySelectorAll("#envRows .envrow").forEach((r) => {
    const k = r.querySelector("[data-k]").value.trim();
    const v = r.querySelector("[data-v]").value;
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
    if (!name) { toast("Server name is required", "err"); return; }
    wiz.step = 3;
    renderWiz();
    return;
  }
  const name = $("srvName").value.trim();
  try {
    $("wNext").disabled = true;
    const srv = await api("/api/servers", { method: "POST", body: { game: wiz.sel, name, env: wiz.env } });
    toast("Server created", "ok");
    closeWizard();
    $("srvName").value = "";
    wiz.env = {};
    loadServers();
    window.location.href = "/manage.html?id=" + encodeURIComponent(srv.id);
  } catch (e) {
    toast(e.message, "err");
  } finally {
    $("wNext").disabled = false;
  }
}

function bind() {
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const r = await api("/api/auth/login", { method: "POST", body: { username: $("loginUser").value.trim(), password: $("loginPass").value } });
      store.token = r.token; store.user = r.user;
      setAuthed(r.user);
      toast("Logged in", "ok");
    } catch (err) { toast(err.message, "err"); }
  });
  $("registerForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const r = await api("/api/auth/register", { method: "POST", body: { username: $("regUser").value.trim(), password: $("regPass").value } });
      store.token = r.token; store.user = r.user;
      setAuthed(r.user);
      toast("Account created", "ok");
    } catch (err) { toast(err.message, "err"); }
  });
  $("logoutBtn").addEventListener("click", logout);
  $("refreshBtn").addEventListener("click", loadServers);
  $("openWizardBtn").addEventListener("click", openWizard);
  $("wClose").addEventListener("click", closeWizard);
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
  $("serverList").addEventListener("click", (e) => {
    const c = e.target.closest("button[data-copy]");
    if (c) {
      const v = c.dataset.copy || "";
      if (navigator.clipboard) navigator.clipboard.writeText(v).then(() => toast("Copied: " + v, "ok")).catch(() => toast(v, ""));
      else { window.prompt("Copy ID:", v); }
      return;
    }
    const b = e.target.closest("button[data-act]");
    if (b) power(b.dataset.id, b.dataset.act);
  });
  const ss = $("serverSearch");
  if (ss) ss.addEventListener("input", renderServerList);
  const nt = $("navToggle");
  if (nt) nt.addEventListener("click", () => document.body.classList.toggle("navopen"));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeWizard(); });
}

async function init() {
  bind();
  if (!store.token) { setAuthed(null); return; }
  try {
    const me = await api("/api/auth/me");
    store.user = me;
    setAuthed(me);
  } catch {
    logout();
  }
}

document.addEventListener("DOMContentLoaded", init);
