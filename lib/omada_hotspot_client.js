// lib/omada_hotspot_client.js
// External Portal flow that matches your working probe:
//   0) GET /hotspot/login (cookies)
//   1) POST /api/v2/hotspot/login  {name, password}  -> get CSRF token from body/header/cookie
//   2) POST /api/v2/hotspot/auth   {site, clientMac, apMac, ssidName, radioId} with Csrf-Token + cookies
//   3) GET  /api/v2/hotspot/loginStatus
//
// Env required (as in probe):
//   OMADA_BASE, OMADA_CONTROLLER_ID, OMADA_OPERATOR_USER, OMADA_OPERATOR_PASS

const OMADA_BASE = (process.env.OMADA_BASE || "https://omada.work2gether.space").replace(/\/+$/, "");
const CTRL = process.env.OMADA_CONTROLLER_ID || "fc2b25d44a950a6357313da0afb4c14a";
const OP_USER = process.env.OMADA_OPERATOR_USER;
const OP_PASS = process.env.OMADA_OPERATOR_PASS;

if (!OP_USER || !OP_PASS) {
  // We keep the throw so callers see a clear error in dev if env isn’t set.
  // In prod you already have these for the probe.
  // eslint-disable-next-line no-throw-literal
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
  // Align with probe behavior
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

function normMac(mac) {
  const hex = String(mac).replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (hex.length !== 12) return mac;
  return hex.match(/.{1,2}/g).join(":");
}

function extractTokenPieces(resp, bodyText) {
  const lower = (k) => k.toLowerCase();
  const hdrs = {};
  resp.headers.forEach((v, k) => (hdrs[lower(k)] = v));

  // 1) JSON body token
  let bodyToken = null;
  try {
    const j = JSON.parse(bodyText || "{}");
    bodyToken = j?.result?.token || j?.token || null;
  } catch { /* ignore */ }

  // 2) Header token (rare)
  const hdrToken = hdrs["csrf-token"] || hdrs["x-csrf-token"] || null;

  // 3) Cookie token-ish
  const sc = resp.headers.get("set-cookie") || "";
  const m =
    String(sc).match(/csrf[-_]?token=([^;]+)/i) ||
    String(sc).match(/x[-_]?csrf[-_]?token=([^;]+)/i) ||
    String(sc).match(/portal[-_]?csrf=([^;]+)/i);
  const cookieToken = m ? m[1] : null;

  return { bodyToken, hdrToken, cookieToken };
}

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
    // Probe uses portal referer for the first POST
    Referer: `${OMADA_BASE}/${CTRL}/portal`,
  };
  const body = JSON.stringify({ name: OP_USER, password: OP_PASS });

  const { resp, jar: j2 } = await fWithCookies(url, { method: "POST", headers, body }, jar);
  const text = await resp.text().catch(() => "");
  let token = null;
  const pieces = extractTokenPieces(resp, text);
  token = pieces.bodyToken || pieces.hdrToken || pieces.cookieToken || null;

  return { status: resp.status, token, raw: text, jar: j2 };
}

async function hotspotAuthorize({ site, clientMac, apMac, ssidName, radioId }, jar = [], token = null) {
  const url = `${OMADA_BASE}/${CTRL}/api/v2/hotspot/auth?_=${Date.now()}`;
  const headers = {
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${OMADA_BASE}/${CTRL}/hotspot/login`,
    ...(token ? { "Csrf-Token": token } : {}),
  };
  const body = JSON.stringify({
    site,
    clientMac: normMac(clientMac),
    apMac: normMac(apMac),
    ssidName,
    radioId,
  });

  const { resp, jar: j2 } = await fWithCookies(url, { method: "POST", headers, body }, jar);
  const text = await resp.text().catch(() => "");
  let data;
  try { data = JSON.parse(text); } catch { data = { errorCode: -1, msg: "Non-JSON auth", raw: text }; }
  return { status: resp.status, data, jar: j2 };
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

// Public API: mirrors probe, then authorizes the client
async function hotspotLogin({ site, clientMac, apMac, ssidName, radioId }) {
  let jar = [];

  // 0) warm cookies
  const pre = await preflightLoginPage(jar);
  jar = pre.jar;

  // 1) operator login -> CSRF token
  const op = await operatorLogin(jar);
  jar = op.jar;
  const token = op.token || null;

  // 2) authorize the client with Csrf-Token
  const auth = await hotspotAuthorize({ site, clientMac, apMac, ssidName, radioId }, jar, token);
  jar = auth.jar;

  // 3) confirm
  const st = await loginStatus(jar, token);

  return {
    preflight: { status: pre.status },
    operatorLogin: { status: op.status, token: !!token },
    auth: { status: auth.status, data: auth.data },
    status: { http: st.status, data: st.data },
    cookies: jar,
  };
}

module.exports = { hotspotLogin, normMac };
