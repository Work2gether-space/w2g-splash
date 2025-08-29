// lib/omada_hotspot_client.js
// External Portal flow with auth-variant probing:
//  0) GET /hotspot/login (cookies)
//  1) POST /api/v2/hotspot/login {name,password} -> CSRF
//  2) POST /api/v2/hotspot/extPortal/auth with multiple MAC formats -> pick first success
//  3) GET  /api/v2/hotspot/loginStatus

const OMADA_BASE = (process.env.OMADA_BASE || "https://omada.work2gether.space").replace(/\/+$/, "");
const CTRL = process.env.OMADA_CONTROLLER_ID || "fc2b25d44a950a6357313da0afb4c14a";
const OP_USER = process.env.OMADA_OPERATOR_USER;
const OP_PASS = process.env.OMADA_OPERATOR_PASS;

if (!OP_USER || !OP_PASS) {
  throw new Error("Missing OMADA_OPERATOR_USER / OMADA_OPERATOR_PASS");
}

// ---------- tiny cookie jar ----------
function parseSetCookie(h) {
  const out = [];
  if (!h) return out;
  const arr = Array.isArray(h) ? h : [h];
  for (const line of arr) {
    const nv = String(line).split(";")[0].trim();
    if (nv.includes("=")) out.push(nv);
  }
  return out;
}
function mergeCookies(a, b) {
  const m = new Map();
  for (const c of [...a, ...b]) {
    const [n, ...rest] = c.split("=");
    m.set(n.trim(), `${n.trim()}=${rest.join("=")}`);
  }
  return [...m.values()];
}
async function fWithCookies(url, opts = {}, jar = []) {
  const headers = new Headers(opts.headers || {});
  if (jar.length) headers.set("Cookie", jar.join("; "));
  if (!headers.has("User-Agent")) headers.set("User-Agent", "w2g-splash/2025-08-29");
  headers.set("Accept", "application/json,text/html;q=0.9,*/*;q=0.1");
  headers.set("Connection", "close");
  headers.set("Pragma", "no-cache");
  headers.set("Cache-Control", "no-cache");
  headers.set("Accept-Language", "en-US,en;q=0.9");
  headers.set("Origin", OMADA_BASE);
  headers.set("Referer", `${OMADA_BASE}/${CTRL}/portal`);

  const resp = await fetch(url, {
    method: opts.method || "GET",
    headers,
    body: opts.body,
    redirect: "manual",
  });

  const set = parseSetCookie(resp.headers.get("set-cookie"));
  const nextJar = mergeCookies(jar, set);
  return { resp, jar: nextJar };
}

// ---------- MAC format helpers ----------
function macRaw(mac) {
  return String(mac).replace(/[^0-9a-f]/gi, "").toUpperCase();
}
function macColons(mac) {
  const hex = macRaw(mac);
  if (hex.length !== 12) return mac;
  return hex.match(/.{1,2}/g).join(":");
}
function macHyphens(mac) {
  const hex = macRaw(mac);
  if (hex.length !== 12) return mac;
  return hex.match(/.{1,2}/g).join("-");
}

// ---------- token extraction ----------
function extractTokenPieces(resp, bodyText) {
  const lower = (k) => k.toLowerCase();
  const hdrs = {};
  resp.headers.forEach((v, k) => (hdrs[lower(k)] = v));

  let bodyToken = null;
  try {
    const j = JSON.parse(bodyText || "{}");
    bodyToken = j?.result?.token || j?.token || null;
  } catch {}

  const hdrToken = hdrs["csrf-token"] || hdrs["x-csrf-token"] || null;

  const sc = resp.headers.get("set-cookie") || "";
  const m =
    String(sc).match(/csrf[-_]?token=([^;]+)/i) ||
    String(sc).match(/x[-_]?csrf[-_]?token=([^;]+)/i) ||
    String(sc).match(/portal[-_]?csrf=([^;]+)/i);
  const cookieToken = m ? m[1] : null;

  return { bodyToken, hdrToken, cookieToken };
}

// ---------- steps ----------
async function preflightLoginPage(jar = []) {
  const url = `${OMADA_BASE}/${CTRL}/hotspot/login?_=${Date.now()}`;
  const { resp, jar: j1 } = await fWithCookies(url, { method: "GET" }, jar);
  await resp.text().catch(() => {});
  return { status: resp.status, jar: j1 };
}

async function operatorLogin(jar = []) {
  const url = `${OMADA_BASE}/${CTRL}/api/v2/hotspot/login?_=${Date.now()}`;
  const headers = {
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${OMADA_BASE}/${CTRL}/portal`,
  };
  const body = JSON.stringify({ name: OP_USER, password: OP_PASS });

  const { resp, jar: j2 } = await fWithCookies(url, { method: "POST", headers, body }, jar);
  const text = await resp.text().catch(() => "");
  const pieces = extractTokenPieces(resp, text);
  const token = pieces.bodyToken || pieces.hdrToken || pieces.cookieToken || null;

  return { status: resp.status, token, raw: text, jar: j2 };
}

async function postExtPortalAuth({ site, clientMac, apMac, ssidName, radioId }, jar = [], token = null) {
  const url = `${OMADA_BASE}/${CTRL}/api/v2/hotspot/extPortal/auth?_=${Date.now()}`;
  const headers = {
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${OMADA_BASE}/${CTRL}/hotspot/login`,
    ...(token ? { "Csrf-Token": token } : {}),
  };
  const body = JSON.stringify({ site, clientMac, apMac, ssidName, radioId });
  const { resp, jar: j2 } = await fWithCookies(url, { method: "POST", headers, body }, jar);
  const text = await resp.text().catch(() => "");
  let data;
  try { data = JSON.parse(text); } catch { data = { errorCode: -1, msg: "Non-JSON auth", raw: text }; }
  return { status: resp.status, data, jar: j2, posted: { site, clientMac, apMac, ssidName, radioId } };
}

async function loginStatus(jar = [], token = null) {
  const url = token
    ? `${OMADA_BASE}/${CTRL}/api/v2/hotspot/loginStatus?token=${encodeURIComponent(token)}&_=${Date.now()}`
    : `${OMADA_BASE}/${CTRL}/api/v2/hotspot/loginStatus?_=${Date.now()}`;

  const { resp, jar: j1 } = await fWithCookies(url, { method: "GET" }, jar);
  const text = await resp.text().catch(() => "");
  let data;
  try { data = JSON.parse(text); } catch { data = { errorCode: -1, msg: "Non-JSON status", raw: text }; }
  return { status: resp.status, data, jar: j1 };
}

// Public API with variant probing
async function hotspotLogin({ site, clientMac, apMac, ssidName, radioId }) {
  let jar = [];

  // 0) warm cookies
  const pre = await preflightLoginPage(jar);
  jar = pre.jar;

  // 1) operator login -> CSRF token
  const op = await operatorLogin(jar);
  jar = op.jar;
  const token = op.token || null;

  // 2) try extPortal/auth with multiple MAC formats
  const variants = [
    { name: "colons",  cm: macColons(clientMac), am: macColons(apMac) },
    { name: "hyphens", cm: macHyphens(clientMac), am: macHyphens(apMac) },
    { name: "rawhex",  cm: macRaw(clientMac),    am: macRaw(apMac) },
  ];

  const attempts = [];
  let chosen = null;

  for (const v of variants) {
    const r = await postExtPortalAuth(
      { site, clientMac: v.cm, apMac: v.am, ssidName, radioId },
      jar,
      token
    );
    attempts.push({ name: v.name, http: r.status, data: r.data, posted: r.posted });
    jar = r.jar;

    if (r.data && r.data.errorCode === 0) {
      chosen = { name: v.name, http: r.status, data: r.data, posted: r.posted };
      break;
    }
  }

  // 3) confirm controller session (operator)
  const st = await loginStatus(jar, token);

  return {
    preflight: { status: pre.status },
    operatorLogin: { status: op.status, token: !!token },
    authAttempts: attempts,
    chosen,
    status: { http: st.status, data: st.data },
    cookies: jar,
  };
}

module.exports = { hotspotLogin, macColons, macHyphens, macRaw };
