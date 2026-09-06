const express = require("express");
const cookieParser = require("cookie-parser");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const webpush = require("web-push");

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
    const initial = { accessCode: null, adminCode: null, properties: [], logs: {}, viewerSessions: [], adminSessions: [], pushSubscriptions: [], knownReservations: {}, monthlyReport: null };
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (!data.viewerSessions) data.viewerSessions = [];
  if (!data.adminSessions) data.adminSessions = [];
  if (!data.pushSubscriptions) data.pushSubscriptions = [];
  if (!data.knownReservations) data.knownReservations = {};
  if (!data.monthlyReport) data.monthlyReport = null;
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

// ---------- Web Push setup ----------

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
const pushEnabled = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (pushEnabled) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.log("Push notifications disabled — set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to enable them.");
}

async function sendPushToAll(title, body) {
  if (!pushEnabled) return;
  const data = loadData();
  if (!data.pushSubscriptions.length) return;
  const payload = JSON.stringify({ title, body });
  const stillValid = [];
  await Promise.all(data.pushSubscriptions.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, payload);
      stillValid.push(sub);
    } catch (e) {
      // 404/410 means the subscription is gone (uninstalled, permissions revoked, etc.) — drop it.
      if (e.statusCode !== 404 && e.statusCode !== 410) stillValid.push(sub);
    }
  }));
  if (stillValid.length !== data.pushSubscriptions.length) {
    const fresh = loadData();
    fresh.pushSubscriptions = stillValid;
    saveData(fresh);
  }
}

function formatDateForNotification(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// ---------- Monthly reports ----------

// "2026-08" style key for the calendar month immediately before today.
function previousMonthKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-indexed; subtracting 1 more below gives last month
  const prev = new Date(y, m - 1, 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

// Builds (or returns the already-built) report for the most recently completed
// month, combined across every property. Regenerating happens lazily, whenever
// someone asks for it after the month has rolled over — no cron needed, and it
// naturally replaces last month's report the first time anyone checks after
// the 1st.
function getOrGenerateMonthlyReport(data) {
  const expectedMonth = previousMonthKey();
  const existing = data.monthlyReport;
  if (existing && existing.forMonth === expectedMonth) return existing;

  let allEntries = [];
  for (const prop of data.properties) {
    const logs = data.logs[prop.id] || {};
    const entries = Object.entries(logs)
      .filter(([dateKey, log]) => log.submitted && dateKey.startsWith(expectedMonth))
      .map(([dateKey, log]) => ({ property: prop.name, date: dateKey, initials: log.initials || "", rating: log.rating, notes: log.notes }));
    allEntries = allEntries.concat(entries);
  }

  const ratings = allEntries.map(e => e.rating).filter(r => r !== null && r !== undefined);
  const avgRating = ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null;

  const notes = allEntries
    .filter(e => e.notes && e.notes.trim())
    .map(e => ({ property: e.property, date: e.date, initials: e.initials, notes: e.notes }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const report = {
    forMonth: expectedMonth,
    monthLabel: monthLabel(expectedMonth),
    generatedAt: new Date().toISOString(),
    totalCleanings: allEntries.length,
    avgRating,
    notes,
  };

  data.monthlyReport = report;
  saveData(data);
  return report;
}



function requireAnyAuth(req, res, next) {
  const data = loadData();
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
    let start = null, end = null, uid = null;
    for (let line of lines) {
      line = line.trim();
      if (line.startsWith("DTSTART")) start = parseICSDate(line.split(":").pop());
      else if (line.startsWith("DTEND")) end = parseICSDate(line.split(":").pop());
      else if (line.startsWith("UID")) uid = line.split(":").slice(1).join(":").trim();
    }
    if (start && end) {
      // Fall back to a start+end key if this feed doesn't provide a UID —
      // this still works fine, it just can't distinguish "moved" from
      // "cancelled + new" for that one reservation.
      events.push({ uid: uid || `${start}_${end}`, start, end });
    }
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
  await checkForCalendarChanges(prop, events);
  return { events, updatedAt: Date.now() };
}

// Compares freshly fetched reservations (tracked by UID, so we can tell a
// moved checkout apart from a cancellation + new booking) against what we've
// seen before for this property, and pushes a notification for anything that
// genuinely changed. The very first fetch for a property just records the
// baseline — it doesn't notify for the whole existing calendar.
async function checkForCalendarChanges(prop, events) {
  const data = loadData();
  const known = data.knownReservations[prop.id];
  const current = {};
  for (const ev of events) current[ev.uid] = { start: ev.start, end: ev.end };

  if (known) {
    const knownUids = Object.keys(known);
    const currentUids = Object.keys(current);

    for (const uid of currentUids) {
      if (!known[uid]) {
        await sendPushToAll("New cleaning added", `${prop.name} — ${formatDateForNotification(current[uid].end)}`);
      } else if (known[uid].end !== current[uid].end) {
        await sendPushToAll(
          "Cleaning date changed",
          `${prop.name} — moved from ${formatDateForNotification(known[uid].end)} to ${formatDateForNotification(current[uid].end)}`
        );
      }
    }

    for (const uid of knownUids) {
      if (!current[uid]) {
        await sendPushToAll("Cleaning cancelled", `${prop.name} — ${formatDateForNotification(known[uid].end)} is no longer needed`);
      }
    }
  }

  data.knownReservations[prop.id] = current;
  saveData(data);
}

// ---------- Auth routes ----------

app.post("/api/login", (req, res) => {
  const data = loadData();
  const { code, remember } = req.body || {};
  if (!data.accessCode) {
    return res.status(401).json({ ok: false, error: "The cleaner access code hasn't been set up yet. Ask the host to configure it." });
  }
  if (code && code.trim().toLowerCase() === data.accessCode.trim().toLowerCase()) {
    const token = crypto.randomBytes(24).toString("hex");
    data.viewerSessions.push(token);
    saveData(data);
    const cookieOpts = { httpOnly: true, sameSite: "lax" };
    if (remember !== false) cookieOpts.maxAge = 1000 * 60 * 60 * 24 * 365;
    res.cookie("tb_session", token, cookieOpts);
    return res.json({ ok: true, hasCode: true });
  }
  return res.status(401).json({ ok: false, error: "Incorrect code" });
});

app.get("/api/session", (req, res) => {
  const data = loadData();
  const token = req.cookies.tb_session;
  const adminToken = req.cookies.tb_admin_session;
  const authed = Boolean(token && data.viewerSessions.includes(token)) || Boolean(adminToken && data.adminSessions.includes(adminToken));
  const isAdmin = Boolean(adminToken && data.adminSessions.includes(adminToken));
  res.json({ authed, hasCode: !!data.accessCode, hasAdminCode: !!data.adminCode, isAdmin });
});

app.post("/api/logout", (req, res) => {
  const data = loadData();
  const token = req.cookies.tb_session;
  const adminToken = req.cookies.tb_admin_session;
  if (token) {
    data.viewerSessions = data.viewerSessions.filter(t => t !== token);
    res.clearCookie("tb_session");
  }
  if (adminToken) {
    data.adminSessions = data.adminSessions.filter(t => t !== adminToken);
    res.clearCookie("tb_admin_session");
  }
  saveData(data);
  res.json({ ok: true });
});

// Host-only login. The host password must already be set via the ADMIN_CODE
// environment variable (or previously through the admin panel) — there is no
// in-app bootstrap, so a stranger reaching this page first can't claim it.
app.post("/api/admin-login", (req, res) => {
  const data = loadData();
  const { code, remember } = req.body || {};
  if (!data.adminCode) {
    return res.status(401).json({ ok: false, error: "The host password hasn't been configured yet. Set the ADMIN_CODE environment variable on the server and redeploy." });
  }
  if (!code || !code.trim() || code.trim().toLowerCase() !== data.adminCode.trim().toLowerCase()) {
    return res.status(401).json({ ok: false, error: "Incorrect host password" });
  }

  const token = crypto.randomBytes(24).toString("hex");
  data.adminSessions.push(token);
  saveData(data);
  const cookieOpts = { httpOnly: true, sameSite: "lax" };
  if (remember !== false) cookieOpts.maxAge = 1000 * 60 * 60 * 24 * 365;
  res.cookie("tb_admin_session", token, cookieOpts);
  res.json({ ok: true });
});

// ---------- Property + access-code management ----------

// A distinct, readable palette for telling properties apart on the combined
// calendar. Assigned once at creation time and never changes after that.
const PROPERTY_COLORS = [
  "#C9748A", "#5B8FC9", "#C99A3E", "#6FA88B", "#9B7FC9", "#C97F5B", "#4FA8A0", "#B36B9E",
];

app.get("/api/properties", requireAnyAuth, (req, res) => {
  const data = loadData();
  // Backfill a color for any property created before this feature existed.
  let changed = false;
  data.properties.forEach((p, i) => {
    if (!p.color) { p.color = PROPERTY_COLORS[i % PROPERTY_COLORS.length]; changed = true; }
  });
  if (changed) saveData(data);
  // Don't leak the raw iCal URL to the browser — it doesn't need it.
  res.json(data.properties.map(p => ({ id: p.id, name: p.name, color: p.color })));
});

app.post("/api/properties", requireAdmin, (req, res) => {
  const data = loadData();
  const { name, icalUrl } = req.body || {};
  if (!name || !icalUrl) return res.status(400).json({ error: "name and icalUrl required" });
  const id = crypto.randomBytes(6).toString("hex");
  const color = PROPERTY_COLORS[data.properties.length % PROPERTY_COLORS.length];
  data.properties.push({ id, name, icalUrl, color });
  data.logs[id] = data.logs[id] || {};
  saveData(data);
  res.json({ id, name, color });
});

app.delete("/api/properties/:id", requireAdmin, (req, res) => {
  const data = loadData();
  data.properties = data.properties.filter(p => p.id !== req.params.id);
  delete data.logs[req.params.id];
  delete data.knownReservations[req.params.id];
  saveData(data);
  icsCache.delete(req.params.id);
  res.json({ ok: true });
});

app.get("/api/monthly-report", requireAdmin, (req, res) => {
  const data = loadData();
  res.json(getOrGenerateMonthlyReport(data));
});

// ---------- Push notifications ----------

app.get("/api/vapid-public-key", requireAnyAuth, (req, res) => {
  res.json({ publicKey: pushEnabled ? VAPID_PUBLIC_KEY : null });
});

app.post("/api/push-subscribe", requireAnyAuth, (req, res) => {
  if (!pushEnabled) return res.status(503).json({ error: "Push notifications aren't configured on this server." });
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: "Invalid subscription" });
  const data = loadData();
  const exists = data.pushSubscriptions.some(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    data.pushSubscriptions.push(subscription);
    saveData(data);
  }
  res.json({ ok: true });
});

app.post("/api/push-unsubscribe", requireAnyAuth, (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: "endpoint required" });
  const data = loadData();
  data.pushSubscriptions = data.pushSubscriptions.filter(s => s.endpoint !== endpoint);
  saveData(data);
  res.json({ ok: true });
});

// ---------- Calendar data ----------

app.get("/api/calendar/:id", requireAnyAuth, async (req, res) => {
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

app.get("/api/logs/:id", requireAnyAuth, (req, res) => {
  const data = loadData();
  res.json(data.logs[req.params.id] || {});
});

app.post("/api/logs/:id", requireAnyAuth, (req, res) => {
  const data = loadData();
  const { dateKey, rating, notes, initials, submitted } = req.body || {};
  if (!dateKey) return res.status(400).json({ error: "dateKey required" });
  if (!data.logs[req.params.id]) data.logs[req.params.id] = {};
  const current = data.logs[req.params.id][dateKey] || { rating: null, notes: "", initials: "", submitted: false };

  if (current.submitted && !isRequestAdmin(req)) {
    return res.status(403).json({ error: "This cleaning has already been submitted — ask your host to make changes." });
  }

  if (submitted === true) {
    const finalRating = rating !== undefined ? rating : current.rating;
    const finalInitials = initials !== undefined ? initials : current.initials;
    const missing = [];
    if (finalRating === null || finalRating === undefined) missing.push("a tidiness rating");
    if (!finalInitials || !finalInitials.trim()) missing.push("initials");
    if (missing.length) {
      return res.status(400).json({ error: "Please fill in " + missing.join(", ") + " before submitting." });
    }
  }

  const justCompleted = submitted === true && !current.submitted;

  data.logs[req.params.id][dateKey] = {
    rating: rating !== undefined ? rating : current.rating,
    notes: notes !== undefined ? notes : current.notes,
    initials: initials !== undefined ? initials : current.initials,
    submitted: submitted !== undefined ? submitted : current.submitted,
  };
  saveData(data);
  res.json({ ok: true });

  if (justCompleted) {
    const prop = data.properties.find(p => p.id === req.params.id);
    if (prop) sendPushToAll("Cleaning completed", `${prop.name} — ${formatDateForNotification(dateKey)}`);
  }
});

app.listen(PORT, () => {
  console.log("Turnover board running on port " + PORT);
});
