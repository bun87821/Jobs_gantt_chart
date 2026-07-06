"use strict";

const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { OAuth2Client } = require("google-auth-library");

const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
  console.warn("⚠ 未設定 SESSION_SECRET，已產生暫時金鑰（重啟後所有人需重新登入）。正式環境請在 Railway 設定 SESSION_SECRET。");
  return crypto.randomBytes(32).toString("hex");
})();
if (!GOOGLE_CLIENT_ID) {
  console.warn("⚠ 未設定 GOOGLE_CLIENT_ID，Google 登入將無法使用。");
}

const EMPTY_STATE = { projects: [], logs: [] };
const MAX_STATE_BYTES = 1_000_000;
const SESSION_DAYS = 30;

/* ---------- 資料儲存層：有 DATABASE_URL 用 Postgres，否則用本機 JSON 檔（開發用） ---------- */
let store;

if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("localhost") || process.env.DATABASE_URL.includes("railway.internal")
      ? false
      : { rejectUnauthorized: false },
  });

  store = {
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          sub        text PRIMARY KEY,
          email      text,
          name       text,
          picture    text,
          data       jsonb NOT NULL DEFAULT '{"projects":[],"logs":[]}'::jsonb,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )`);
      console.log("已連線 Postgres");
    },
    async upsertUser({ sub, email, name, picture }) {
      await pool.query(
        `INSERT INTO users (sub, email, name, picture) VALUES ($1,$2,$3,$4)
         ON CONFLICT (sub) DO UPDATE SET email=$2, name=$3, picture=$4, updated_at=now()`,
        [sub, email, name, picture]
      );
    },
    async getData(sub) {
      const r = await pool.query("SELECT data FROM users WHERE sub=$1", [sub]);
      return r.rows[0] ? r.rows[0].data : EMPTY_STATE;
    },
    async setData(sub, data) {
      await pool.query("UPDATE users SET data=$2, updated_at=now() WHERE sub=$1", [sub, JSON.stringify(data)]);
    },
  };
} else {
  const DATA_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, "data"), "store.json");

  function readAll() {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return {}; }
  }
  function writeAll(all) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(all));
  }

  store = {
    async init() {
      console.warn("⚠ 未設定 DATABASE_URL，改用本機檔案儲存（僅適合開發測試）：" + DATA_FILE);
    },
    async upsertUser(u) {
      const all = readAll();
      all[u.sub] = { ...(all[u.sub] || { data: EMPTY_STATE }), ...u };
      writeAll(all);
    },
    async getData(sub) {
      const all = readAll();
      return (all[sub] && all[sub].data) || EMPTY_STATE;
    },
    async setData(sub, data) {
      const all = readAll();
      if (!all[sub]) all[sub] = {};
      all[sub].data = data;
      writeAll(all);
    },
  };
}

/* ---------- App ---------- */
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

function isSecure(req) {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

function setSession(req, res, user) {
  const token = jwt.sign(
    { sub: user.sub, email: user.email, name: user.name, picture: user.picture },
    SESSION_SECRET,
    { expiresIn: `${SESSION_DAYS}d` }
  );
  res.cookie("session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecure(req),
    maxAge: SESSION_DAYS * 86400000,
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies.session;
  if (!token) return res.status(401).json({ error: "not_logged_in" });
  try {
    req.user = jwt.verify(token, SESSION_SECRET);
    next();
  } catch {
    res.clearCookie("session");
    res.status(401).json({ error: "invalid_session" });
  }
}

/* ---------- API ---------- */
app.get("/api/config", (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID });
});

app.post("/api/auth/google", async (req, res) => {
  try {
    const { credential } = req.body || {};
    if (!credential) return res.status(400).json({ error: "missing_credential" });
    if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: "server_not_configured" });

    const ticket = await oauthClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    const user = { sub: p.sub, email: p.email || "", name: p.name || "", picture: p.picture || "" };
    await store.upsertUser(user);
    setSession(req, res, user);
    res.json(user);
  } catch (e) {
    console.error("Google 登入驗證失敗:", e.message);
    res.status(401).json({ error: "invalid_token" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("session");
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  const { sub, email, name, picture } = req.user;
  res.json({ sub, email, name, picture });
});

app.get("/api/state", requireAuth, async (req, res) => {
  try {
    const data = await store.getData(req.user.sub);
    res.json({
      projects: Array.isArray(data.projects) ? data.projects : [],
      logs: Array.isArray(data.logs) ? data.logs : [],
    });
  } catch (e) {
    console.error("讀取資料失敗:", e.message);
    res.status(500).json({ error: "db_error" });
  }
});

app.put("/api/state", requireAuth, async (req, res) => {
  const data = req.body;
  if (!data || !Array.isArray(data.projects) || !Array.isArray(data.logs)) {
    return res.status(400).json({ error: "bad_format" });
  }
  const payload = { projects: data.projects, logs: data.logs };
  if (JSON.stringify(payload).length > MAX_STATE_BYTES) {
    return res.status(413).json({ error: "too_large" });
  }
  try {
    await store.setData(req.user.sub, payload);
    res.json({ ok: true });
  } catch (e) {
    console.error("寫入資料失敗:", e.message);
    res.status(500).json({ error: "db_error" });
  }
});

/* ---------- 靜態檔案 ---------- */
app.use(express.static(path.join(__dirname, "public")));

store.init().then(() => {
  app.listen(PORT, () => console.log(`伺服器啟動於 http://localhost:${PORT}`));
}).catch(e => {
  console.error("初始化失敗:", e);
  process.exit(1);
});
