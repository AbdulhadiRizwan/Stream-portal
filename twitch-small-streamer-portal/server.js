require("dotenv").config();

const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";
const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "portal.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  action TEXT NOT NULL,
  target TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE SET NULL
);
`);

const seedUsername = (process.env.ADMIN_USERNAME || "admin").trim();
const seedPassword = process.env.ADMIN_PASSWORD || "102030";
if (!db.prepare("SELECT id FROM users WHERE username = ?").get(seedUsername)) {
  const hash = bcrypt.hashSync(seedPassword, 12);
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')").run(seedUsername, hash);
  console.log(`Seeded initial administrator "${seedUsername}". Change its password after signing in.`);
}

app.set("trust proxy", isProduction ? 1 : false);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https://static-cdn.jtvnw.net", "https://*.jtvnw.net"],
      frameSrc: ["https://player.twitch.tv", "https://www.twitch.tv"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: isProduction ? [] : null
    }
  }
}));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public"), { index: false }));
app.use(session({
  name: "streamportal.sid",
  secret: process.env.SESSION_SECRET || (isProduction ? "" : "local-development-only-change-me"),
  resave: false,
  saveUninitialized: false,
  store: new SQLiteStore({ db: "sessions.db", dir: dataDir }),
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    maxAge: 1000 * 60 * 60 * 8
  }
}));
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false });
const adminLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

function audit(actorId, action, target = "") {
  db.prepare("INSERT INTO audit_log (actor_id, action, target) VALUES (?, ?, ?)").run(actorId || null, action, String(target).slice(0, 200));
}
function currentUser(req) {
  if (!req.session.userId) return null;
  return db.prepare("SELECT id, username, role, disabled FROM users WHERE id = ?").get(req.session.userId) || null;
}
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user || user.disabled) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: "Please sign in." });
  }
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Administrator access required." });
  next();
}
function safeUser(u) {
  return { id: u.id, username: u.username, role: u.role, disabled: Boolean(u.disabled), createdAt: u.created_at, lastLogin: u.last_login || null };
}
function csrf(req, res, next) {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.path.startsWith("/api/")) {
    const token = req.get("x-csrf-token");
    if (!req.session.csrfToken || !token || token !== req.session.csrfToken) {
      return res.status(403).json({ error: "Invalid security token. Refresh and try again." });
    }
  }
  next();
}
app.use(csrf);

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/api/session", (req, res) => {
  const user = currentUser(req);
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString("hex");
  res.json({ user: user && !user.disabled ? { id: user.id, username: user.username, role: user.role } : null, csrfToken: req.session.csrfToken });
});

app.post("/api/login", loginLimiter, async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (!username || !password || username.length > 64 || password.length > 200) return res.status(400).json({ error: "Enter a valid username and password." });
  const user = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username);
  const valid = user && !user.disabled && await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    audit(null, "login_failed", username);
    return res.status(401).json({ error: "Invalid username or password." });
  }
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "Could not start session." });
    req.session.userId = user.id;
    req.session.csrfToken = crypto.randomBytes(24).toString("hex");
    db.prepare("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?").run(user.id);
    audit(user.id, "login", username);
    res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role }, csrfToken: req.session.csrfToken });
  });
});

app.post("/api/logout", requireAuth, (req, res) => {
  audit(req.user.id, "logout", req.user.username);
  req.session.destroy(() => {
    res.clearCookie("streamportal.sid", { httpOnly: true, sameSite: "lax", secure: isProduction });
    res.json({ ok: true });
  });
});

app.post("/api/change-password", requireAuth, async (req, res) => {
  const oldPassword = String(req.body.oldPassword || "");
  const newPassword = String(req.body.newPassword || "");
  if (newPassword.length < 10 || newPassword.length > 200) return res.status(400).json({ error: "New password must be at least 10 characters." });
  const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user.id);
  if (!await bcrypt.compare(oldPassword, row.password_hash)) return res.status(400).json({ error: "Current password is incorrect." });
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await bcrypt.hash(newPassword, 12), req.user.id);
  audit(req.user.id, "password_changed", req.user.username);
  res.json({ ok: true });
});

app.get("/api/admin/users", requireAuth, requireAdmin, adminLimiter, (req, res) => {
  const users = db.prepare("SELECT id, username, role, disabled, created_at, last_login FROM users ORDER BY id ASC").all();
  res.json({ users: users.map(safeUser) });
});

app.post("/api/admin/users", requireAuth, requireAdmin, adminLimiter, async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const role = req.body.role === "admin" ? "admin" : "user";
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return res.status(400).json({ error: "Username must be 3–32 characters: letters, numbers, dot, underscore, hyphen." });
  if (password.length < 10 || password.length > 200) return res.status(400).json({ error: "Password must be at least 10 characters." });
  try {
    const result = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)").run(username, await bcrypt.hash(password, 12), role);
    audit(req.user.id, "user_created", username);
    res.status(201).json({ ok: true, id: result.lastInsertRowid });
  } catch (e) {
    if (String(e.code).includes("CONSTRAINT")) return res.status(409).json({ error: "That username already exists." });
    throw e;
  }
});

app.patch("/api/admin/users/:id", requireAuth, requireAdmin, adminLimiter, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) return res.status(400).json({ error: "Invalid user id." });
  const target = db.prepare("SELECT id, username, role FROM users WHERE id = ?").get(id);
  if (!target) return res.status(404).json({ error: "User not found." });
  if (id === req.user.id && req.body.disabled) return res.status(400).json({ error: "You cannot disable your own account." });
  if (id === req.user.id && req.body.role && req.body.role !== "admin") return res.status(400).json({ error: "You cannot remove your own administrator role." });
  if (typeof req.body.disabled === "boolean") {
    db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(req.body.disabled ? 1 : 0, id);
    if (req.body.disabled) db.prepare("DELETE FROM sessions WHERE sess LIKE ?").run(`%\"userId\":${id}%`);
    audit(req.user.id, req.body.disabled ? "user_disabled" : "user_enabled", target.username);
  }
  if (req.body.role === "admin" || req.body.role === "user") {
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(req.body.role, id);
    audit(req.user.id, "role_changed", `${target.username}:${req.body.role}`);
  }
  res.json({ ok: true });
});

app.delete("/api/admin/users/:id", requireAuth, requireAdmin, adminLimiter, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id === req.user.id) return res.status(400).json({ error: "Invalid target; you cannot delete yourself." });
  const target = db.prepare("SELECT username FROM users WHERE id = ?").get(id);
  if (!target) return res.status(404).json({ error: "User not found." });
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  audit(req.user.id, "user_deleted", target.username);
  res.json({ ok: true });
});

app.get("/api/admin/active-sessions", requireAuth, requireAdmin, (req, res) => {
  // Sessions are stored server-side. This query intentionally returns usernames and
  // timestamps only, never session IDs or cookie values.
  const rows = db.prepare("SELECT sess, expired FROM sessions WHERE expired > ?").all(Date.now());
  const active = [];
  for (const row of rows) {
    try {
      const s = JSON.parse(row.sess);
      if (s.userId) {
        const u = db.prepare("SELECT id, username, role FROM users WHERE id = ? AND disabled = 0").get(s.userId);
        if (u) active.push({ userId: u.id, username: u.username, role: u.role, lastActivity: s.cookie?.expires || null });
      }
    } catch {}
  }
  const unique = [...new Map(active.map(x => [x.userId, x])).values()];
  res.json({ sessions: unique });
});

app.get("/api/admin/audit", requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT a.id, u.username AS actor, a.action, a.target, a.created_at
    FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
    ORDER BY a.id DESC LIMIT 100`).all();
  res.json({ events: rows });
});

// Twitch OAuth client credentials are kept on the server, never in browser code.
let twitchToken = null;
let twitchTokenExpiresAt = 0;
async function getTwitchToken() {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Twitch API is not configured yet. Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in your deployment environment.");
  if (twitchToken && Date.now() < twitchTokenExpiresAt - 60000) return twitchToken;
  const url = new URL("https://id.twitch.tv/oauth2/token");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("client_secret", clientSecret);
  url.searchParams.set("grant_type", "client_credentials");
  const response = await fetch(url, { method: "POST" });
  if (!response.ok) throw new Error(`Twitch token request failed (${response.status}).`);
  const data = await response.json();
  twitchToken = data.access_token;
  twitchTokenExpiresAt = Date.now() + (data.expires_in * 1000);
  return twitchToken;
}
async function twitchGet(url) {
  const token = await getTwitchToken();
  const response = await fetch(url, { headers: { "Client-ID": process.env.TWITCH_CLIENT_ID, "Authorization": `Bearer ${token}` } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Twitch API error (${response.status}): ${body.slice(0, 180)}`);
  }
  return response.json();
}
app.get("/api/streams", requireAuth, async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 100)));
    const url = new URL("https://api.twitch.tv/helix/streams");
    url.searchParams.set("first", String(limit));
    const game = String(req.query.game || "").trim().slice(0, 100);
    const language = String(req.query.language || "").trim().slice(0, 10);
    if (game) url.searchParams.set("game_id", game);
    if (language) url.searchParams.set("language", language);
    const data = await twitchGet(url);
    // Helix streams do not include follower count or reliable city/country. Do not
    // label these channels as under-50 without verification. Follow-up lookup is
    // limited to candidate IDs and only works with the required app permissions.
    const streams = data.data.map(s => ({
      id: s.id, userId: s.user_id, username: s.user_name, title: s.title,
      gameName: s.game_name, language: s.language, viewerCount: s.viewer_count,
      startedAt: s.started_at, thumbnailUrl: s.thumbnail_url.replace("{width}", "480").replace("{height}", "270"),
      isLive: true, followerCount: null, qualifiesUnder50: null, region: null
    }));
    res.json({ streams, note: "Twitch's live-stream endpoint does not include follower counts or streamer city/country. These streams are unverified for the under-50 filter." });
  } catch (e) {
    res.status(502).json({ error: e.message || "Unable to load Twitch streams." });
  }
});

// Lookup followers for a specific Twitch user ID when the API supports the
// endpoint and the app has permission. A directory-wide follower scan is not
// available through one public endpoint.
app.get("/api/streams/:userId/followers", requireAuth, async (req, res) => {
  try {
    const userId = String(req.params.userId || "");
    if (!/^\d{1,30}$/.test(userId)) return res.status(400).json({ error: "Invalid Twitch user ID." });
    const url = new URL("https://api.twitch.tv/helix/channels/followers");
    url.searchParams.set("broadcaster_id", userId);
    url.searchParams.set("first", "1");
    const result = await twitchGet(url);
    const total = Number(result.total);
    res.json({ followerCount: Number.isFinite(total) ? total : null, qualifiesUnder50: Number.isFinite(total) ? total < 50 : null });
  } catch (e) {
    res.status(502).json({ error: e.message || "Follower count could not be verified. Check Twitch app permissions." });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
});

app.listen(PORT, () => console.log(`Stream portal running on http://localhost:${PORT}`));
