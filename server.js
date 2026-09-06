const express = require("express");
const cookieParser = require("cookie-parser");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data", "data.json");

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

app.get("/host", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- Data persistence (simple JSON file — fine for this scale) ----------

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = { accessCode: null, adminCode: null, properties: [], logs: {}, viewerSessions: [], adminSessions: [] };
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (!data.viewerSessions) data.viewerSessions = [];
  if (!data.adminSessions) data.adminSessions = [];
  return data;
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Optional env-var override for the codes — lets the real host reset either
// code from Render's dashboard (Environment tab) if it ever gets messed up,
// without depending on already-broken in-app access. Set ACCESS_CODE and/or
// ADMIN_CODE as environment variables and redeploy to force them.
(function applyEnvCodeOverrides() {
  const data = loadData();
  let changed = false;
  if (process.env.ACCESS_CODE && process.env.ACCESS_CODE !== data.accessCode) {
    data.accessCode = process.env.ACCESS_CODE;
    changed = true;
  }
  if (process.env.ADMIN_CODE && process.env.ADMIN_CODE !== data.adminCode) {
    data.adminCode = process.env.ADMIN_CODE;
    changed = true;
  }
  if (changed) saveData(data);
})();

// ---------- Sessions (persisted to disk so they survive redeploys/restarts) ----------

function requireAuthIfCodeSet(req, res, next) {
  const data = loadData();
  if (!data.accessCode) return next(); // no code set yet — open access
  const token = req.cookies.tb_session;
  const adminToken = req.cookies.tb_admin_session;
  if (token && data.viewerSessions.includes(token)) return next();
  if (adminToken && data.adminSessions.includes(adminToken)) return next(); // host can always view too
  return res.status(401).json({ error: "Not authorized" });
}

function requireAdmin(req, res, next) {
  const data = loadData();
  if (!data.adminCode) return res.status(401).json({ error: "Host password not set yet" });
  const token = req.cookies.tb_admin_session;
  if (token && data.adminSessions.includes(token)) return next();
  return res.status(401).json({ error: "Host login required" });
}

function isRequestAdmin(req) {
  const data = loadData();
  const token = req.cookies.tb_admin_session;
  return Boolean(token && data.adminSessions.includes(token));
}

// ---------- ICS parsing (server-side — no CORS issue here) ----------

function parseICSDate(val) {
  const v = val.trim();
  const y = v.slice(0, 4);
  const mo = v.slice(4, 6);
  const da = v.slice(6, 8);
  return `${y}-${mo}-${da}`; // plain date string — no timezone, so no shifting later
}

function parseICS(text) {
  const events = [];
  const blocks = text.split("BEGIN:VEVENT").slice(1);
  for (const block of blocks) {
    const body = block.split("END:VEVENT")[0];
    const lines = body.split(/\r?\n/);
    let start = null, end = null;
    for (let line of lines) {
      line = line.trim();
      if (line.startsWith("DTSTART")) start = parseICSDate(line.split(":").pop());
      else if (line.startsWith("DTEND")) end = parseICSDate(line.split(":").pop());
    }
    if (start && end) events.push({ start, end });
  }
  return events;
}

// Cache fetched calendars for a few minutes to avoid hammering Airbnb
const icsCache = new Map(); // propId -> { events, fetchedAt }
const CACHE_MS = 10 * 60 * 1000;

async function getEventsForProperty(prop) {
  const cached = icsCache.get(prop.id);
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) {
    return { events: cached.events, updatedAt: cached.fetchedAt };
  }
  const res = await fetch(prop.icalUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; TurnoverBoard/1.0)" } });
  if (!res.ok) throw new Error("Airbnb returned HTTP " + res.status);
  const text = await res.text();
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("Response wasn't a calendar file");
  const events = parseICS(text);
  icsCache.set(prop.id, { events, fetchedAt: Date.now() });
  return { events, updatedAt: Date.now() };
}

// ---------- Auth routes ----------

app.post("/api/login", (req, res) => {
  const data = loadData();
  const { code } = req.body || {};
  if (!data.accessCode || (code && code.trim().toLowerCase() === data.accessCode.trim().toLowerCase())) {
    const token = crypto.randomBytes(24).toString("hex");
    data.viewerSessions.push(token);
    saveData(data);
    res.cookie("tb_session", token, { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 24 * 365 });
    return res.json({ ok: true, hasCode: !!data.accessCode });
  }
  return res.status(401).json({ ok: false, error: "Incorrect code" });
});

app.get("/api/session", (req, res) => {
  const data = loadData();
  const token = req.cookies.tb_session;
  const adminToken = req.cookies.tb_admin_session;
  const authed = !data.accessCode || Boolean(token && data.viewerSessions.includes(token)) || Boolean(adminToken && data.adminSessions.includes(adminToken));
  const isAdmin = Boolean(adminToken && data.adminSessions.includes(adminToken));
  res.json({ authed, hasCode: !!data.accessCode, hasAdminCode: !!data.adminCode, isAdmin });
});

// Host-only login. First person to set this becomes the host password (bootstrap).
app.post("/api/admin-login", (req, res) => {
  const data = loadData();
  const { code } = req.body || {};
  if (!code || !code.trim()) return res.status(400).json({ ok: false, error: "Enter a password" });

  if (!data.adminCode) {
    // Bootstrap: first password entered here becomes the permanent host password.
    data.adminCode = code.trim();
  } else if (code.trim().toLowerCase() !== data.adminCode.trim().toLowerCase()) {
    return res.status(401).json({ ok: false, error: "Incorrect host password" });
  }

  const token = crypto.randomBytes(24).toString("hex");
  data.adminSessions.push(token);
  saveData(data);
  res.cookie("tb_admin_session", token, { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 24 * 365 });
  res.json({ ok: true });
});

// ---------- Property + access-code management ----------

app.get("/api/properties", requireAuthIfCodeSet, (req, res) => {
  const data = loadData();
  // Don't leak the raw iCal URL to the browser — it doesn't need it.
  res.json(data.properties.map(p => ({ id: p.id, name: p.name })));
});

app.post("/api/properties", requireAdmin, (req, res) => {
  const data = loadData();
  const { name, icalUrl } = req.body || {};
  if (!name || !icalUrl) return res.status(400).json({ error: "name and icalUrl required" });
  const id = crypto.randomBytes(6).toString("hex");
  data.properties.push({ id, name, icalUrl });
  data.logs[id] = data.logs[id] || {};
  saveData(data);
  res.json({ id, name });
});

app.delete("/api/properties/:id", requireAdmin, (req, res) => {
  const data = loadData();
  data.properties = data.properties.filter(p => p.id !== req.params.id);
  delete data.logs[req.params.id];
  saveData(data);
  icsCache.delete(req.params.id);
  res.json({ ok: true });
});

app.post("/api/access-code", requireAdmin, (req, res) => {
  const data = loadData();
  const { code } = req.body || {};
  data.accessCode = code ? code.trim() : null;
  saveData(data);
  res.json({ ok: true });
});

// ---------- Calendar data ----------

app.get("/api/calendar/:id", requireAuthIfCodeSet, async (req, res) => {
  const data = loadData();
  const prop = data.properties.find(p => p.id === req.params.id);
  if (!prop) return res.status(404).json({ error: "not found" });
  try {
    const { events, updatedAt } = await getEventsForProperty(prop);
    res.json({ events, updatedAt });
  } catch (e) {
    res.status(502).json({ error: e.message || "Couldn't load calendar" });
  }
});

// ---------- Cleaning logs ----------

app.get("/api/logs/:id", requireAuthIfCodeSet, (req, res) => {
  const data = loadData();
  res.json(data.logs[req.params.id] || {});
});

app.post("/api/logs/:id", requireAuthIfCodeSet, (req, res) => {
  const data = loadData();
  const { dateKey, rating, notes, initials, submitted } = req.body || {};
  if (!dateKey) return res.status(400).json({ error: "dateKey required" });
  if (!data.logs[req.params.id]) data.logs[req.params.id] = {};
  const current = data.logs[req.params.id][dateKey] || { rating: null, notes: "", initials: "", submitted: false };

  if (current.submitted && !isRequestAdmin(req)) {
    return res.status(403).json({ error: "This cleaning has already been submitted — ask your host to make changes." });
  }

  data.logs[req.params.id][dateKey] = {
    rating: rating !== undefined ? rating : current.rating,
    notes: notes !== undefined ? notes : current.notes,
    initials: initials !== undefined ? initials : current.initials,
    submitted: submitted !== undefined ? submitted : current.submitted,
  };
  saveData(data);
  res.json({ ok: true });
});

app.post("/api/admin-code", requireAdmin, (req, res) => {
  const data = loadData();
  const { code } = req.body || {};
  if (!code || !code.trim()) return res.status(400).json({ error: "New password required" });
  data.adminCode = code.trim();
  saveData(data);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log("Turnover board running on port " + PORT);
});
