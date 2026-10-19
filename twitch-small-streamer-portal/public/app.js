const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
let csrfToken = "";
let currentUser = null;
let allStreams = [];
let adminTab = "users";

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  if (["POST", "PUT", "PATCH", "DELETE"].includes((options.method || "GET").toUpperCase())) headers["x-csrf-token"] = csrfToken;
  const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function showError(el, msg) { el.textContent = msg || ""; }
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function setLoggedIn(user) {
  currentUser = user;
  $("#login-view").classList.toggle("hidden", !!user);
  $("#app-view").classList.toggle("hidden", !user);
  $("#logout-button").classList.toggle("hidden", !user);
  $("#user-badge").classList.toggle("hidden", !user);
  $("#user-badge").textContent = user ? `${user.username} · ${user.role}` : "";
  $("#admin-panel").classList.toggle("hidden", user?.role !== "admin");
}
async function bootstrap() {
  try {
    const s = await fetch("/api/session", { credentials: "same-origin" }).then(r => r.json());
    csrfToken = s.csrfToken;
    if (s.user) {
      setLoggedIn(s.user);
      await loadStreams();
      if (s.user.role === "admin") await loadAdminTab();
    }
  } catch {}
}
$("#login-form").addEventListener("submit", async e => {
  e.preventDefault();
  showError($("#login-error"), "");
  const username = $("#username").value.trim();
  const password = $("#password").value;
  try {
    const data = await api("/api/login", { method: "POST", body: JSON.stringify({ username, password }) });
    csrfToken = data.csrfToken;
    setLoggedIn(data.user);
    $("#password").value = "";
    await loadStreams();
    if (data.user.role === "admin") await loadAdminTab();
  } catch (err) { showError($("#login-error"), err.message); }
});
$("#logout-button").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST", body: "{}" }); } catch {}
  setLoggedIn(null);
  allStreams = [];
  $("#stream-grid").innerHTML = "";
});
$("#refresh-button").addEventListener("click", loadStreams);
$("#search").addEventListener("input", renderStreams);
$("#language-filter").addEventListener("change", loadStreams);
$("#follower-filter").addEventListener("change", renderStreams);

function setNotice(message, type = "") {
  const el = $("#notice");
  el.textContent = message;
  el.className = `notice ${type}`;
}
async function loadStreams() {
  if (!currentUser) return;
  $("#stream-grid").innerHTML = "";
  setNotice("Loading live streams from Twitch…");
  try {
    const language = $("#language-filter").value;
    const qs = new URLSearchParams({ limit: "100" });
    if (language) qs.set("language", language);
    const data = await api(`/api/streams?${qs}`);
    allStreams = data.streams || [];
    setNotice(data.note || "Live directory updated.", "success");
    renderStreams();
  } catch (err) {
    allStreams = [];
    renderStreams();
    setNotice(`${err.message} Add your Twitch app credentials to the hosting environment to enable live discovery.`, "error-notice");
  }
}
function renderStreams() {
  const query = ($("#search").value || "").trim().toLowerCase();
  const under50 = $("#follower-filter").value === "under50";
  const list = allStreams.filter(s => {
    const matches = `${s.username} ${s.title} ${s.gameName}`.toLowerCase().includes(query);
    const followers = !under50 || s.qualifiesUnder50 === true;
    return matches && followers;
  });
  $("#stream-count").textContent = `${list.length} stream${list.length === 1 ? "" : "s"}`;
  $("#stream-grid").innerHTML = "";
  $("#empty-state").classList.toggle("hidden", list.length !== 0);
  if (under50) setNotice("Only verified follower counts can qualify. Twitch's general live directory does not expose follower counts for every channel, so some eligible small channels may not appear.", "");
  list.forEach(stream => {
    const card = $("#stream-template").content.firstElementChild.cloneNode(true);
    const twitchUrl = `https://www.twitch.tv/${encodeURIComponent(stream.username)}`;
    $(".thumbnail-link", card).href = twitchUrl;
    $(".thumbnail", card).src = stream.thumbnailUrl;
    $(".thumbnail", card).alt = `${stream.username}'s live stream thumbnail`;
    $(".viewers", card).textContent = `${Number(stream.viewerCount || 0).toLocaleString()} watching`;
    $(".avatar", card).textContent = (stream.username || "?").slice(0, 1).toUpperCase();
    $(".streamer-name", card).textContent = stream.username;
    $(".game-name", card).textContent = stream.gameName || "Just Chatting";
    $(".stream-title", card).textContent = stream.title || "Live now";
    $(".language-tag", card).textContent = (stream.language || "unknown").toUpperCase();
    const followerTag = $(".followers-tag", card);
    if (Number.isFinite(stream.followerCount)) {
      followerTag.textContent = `${stream.followerCount} followers`;
      followerTag.classList.add("verified");
    } else {
      followerTag.textContent = "Followers unverified";
    }
    $(".watch-link", card).href = twitchUrl;
    $("#stream-grid").append(card);
  });
}
$$(".tab").forEach(tab => tab.addEventListener("click", async () => {
  adminTab = tab.dataset.tab;
  $$(".tab").forEach(t => t.classList.toggle("active", t === tab));
  await loadAdminTab();
}));
async function loadAdminTab() {
  if (currentUser?.role !== "admin") return;
  const content = $("#admin-content");
  content.innerHTML = '<p class="muted">Loading admin data…</p>';
  try {
    if (adminTab === "users") await renderUsers(content);
    if (adminTab === "sessions") await renderSessions(content);
    if (adminTab === "audit") await renderAudit(content);
    if (adminTab === "password") renderPasswordForm(content);
  } catch (e) { content.textContent = e.message; }
}
async function renderUsers(content) {
  const { users } = await api("/api/admin/users");
  content.innerHTML = `
    <div class="admin-toolbar"><h3>Account management</h3><button id="show-add-user" class="button primary">＋ Add user</button></div>
    <form id="add-user-form" class="admin-form hidden">
      <input name="username" placeholder="Username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_.-]+" aria-label="New username">
      <input name="password" placeholder="Temporary password (10+ chars)" type="password" required minlength="10" maxlength="200" aria-label="Temporary password">
      <select name="role" aria-label="New user role"><option value="user">Regular user</option><option value="admin">Administrator</option></select>
      <button class="button primary">Create account</button>
    </form>
    <p id="admin-message" class="admin-message"></p>
    <div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last login</th><th>Actions</th></tr></thead><tbody>
    ${users.map(u => `<tr><td>${escapeHtml(u.username)}</td><td>${escapeHtml(u.role)}</td><td><span class="status-pill ${u.disabled ? "off" : ""}">${u.disabled ? "Disabled" : "Enabled"}</span></td><td>${escapeHtml(u.lastLogin || "Never")}</td><td><div class="row-actions">${u.id === currentUser.id ? "" : `<button class="mini-button" data-action="toggle" data-id="${u.id}" data-disabled="${u.disabled}">${u.disabled ? "Enable" : "Disable"}</button><button class="mini-button" data-action="role" data-id="${u.id}" data-role="${u.role}">${u.role === "admin" ? "Make user" : "Make admin"}</button><button class="mini-button danger" data-action="delete" data-id="${u.id}" data-name="${escapeHtml(u.username)}">Delete</button>`}</div></td></tr>`).join("")}
    </tbody></table></div>`;
  $("#show-add-user", content).addEventListener("click", () => $("#add-user-form", content).classList.toggle("hidden"));
  $("#add-user-form", content).addEventListener("submit", async e => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api("/api/admin/users", { method: "POST", body: JSON.stringify({ username: f.get("username"), password: f.get("password"), role: f.get("role") }) });
      $("#admin-message", content).textContent = "Account created.";
      await renderUsers(content);
    } catch (err) { $("#admin-message", content).textContent = err.message; }
  });
  $$("[data-action]", content).forEach(button => button.addEventListener("click", async () => {
    const id = button.dataset.id;
    try {
      if (button.dataset.action === "toggle") await api(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify({ disabled: button.dataset.disabled !== "true" }) });
      if (button.dataset.action === "role") {
        const role = button.dataset.role === "admin" ? "user" : "admin";
        if (!confirm(`Change this account's role to ${role}?`)) return;
        await api(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify({ role }) });
      }
      if (button.dataset.action === "delete") {
        if (!confirm(`Permanently delete ${button.dataset.name}?`)) return;
        await api(`/api/admin/users/${id}`, { method: "DELETE", body: "{}" });
      }
      await renderUsers(content);
    } catch (err) { $("#admin-message", content).textContent = err.message; }
  }));
}
async function renderSessions(content) {
  const { sessions } = await api("/api/admin/active-sessions");
  content.innerHTML = `<div class="admin-toolbar"><h3>Currently active accounts</h3><button id="refresh-sessions" class="button secondary">Refresh</button></div><p class="muted">Sessions can expire naturally; this view lists accounts with valid stored sessions, not a guaranteed live-presence signal.</p><div class="table-wrap"><table><thead><tr><th>Account</th><th>Role</th><th>Session expiry</th></tr></thead><tbody>${sessions.map(s => `<tr><td>${escapeHtml(s.username)}</td><td>${escapeHtml(s.role)}</td><td>${escapeHtml(s.lastActivity || "Session active")}</td></tr>`).join("")}</tbody></table></div>${sessions.length ? "" : '<p class="muted">No active sessions found.</p>'}`;
  $("#refresh-sessions", content).addEventListener("click", loadAdminTab);
}
async function renderAudit(content) {
  const { events } = await api("/api/admin/audit");
  content.innerHTML = `<div class="admin-toolbar"><h3>Recent security and account events</h3></div><ul class="audit-list">${events.map(e => `<li><span><strong>${escapeHtml(e.action)}</strong><br><span class="muted">${escapeHtml(e.actor || "System")} ${e.target ? "· " + escapeHtml(e.target) : ""}</span></span><time>${escapeHtml(e.created_at)}</time></li>`).join("")}</ul>${events.length ? "" : '<p class="muted">No events yet.</p>'}`;
}
function renderPasswordForm(content) {
  content.innerHTML = `<h3>Change your password</h3><p class="muted">Use a unique password with at least 10 characters.</p><form id="change-password-form" class="change-password"><label>Current password<input name="oldPassword" type="password" required autocomplete="current-password"></label><label>New password<input name="newPassword" type="password" required minlength="10" autocomplete="new-password"></label><button class="button primary">Update password</button><p id="password-message" class="admin-message"></p></form>`;
  $("#change-password-form", content).addEventListener("submit", async e => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api("/api/change-password", { method: "POST", body: JSON.stringify({ oldPassword: f.get("oldPassword"), newPassword: f.get("newPassword") }) });
      $("#password-message", content).textContent = "Password updated.";
      e.currentTarget.reset();
    } catch (err) { $("#password-message", content).textContent = err.message; }
  });
}
bootstrap();
