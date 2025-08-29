// lib/omada_hotspot_client.js
// Vercel Node 18+ (native fetch). External Portal flow:
//  0) GET /hotspot/login  -> establish cookies
//  1) GET /api/v2/hotspot/csrf -> (often 302 but may yield token)
//  2) POST /api/v2/hotspot/auth  -> authorize client for Wi-Fi
//  3) GET /api/v2/hotspot/loginStatus -> verify open state

const OMADA_BASE = process.env.OMADA_BASE || "https://omada.work2gether.space";
const OMADA_CONTROLLER_ID =
  process.env.OMADA_CONTROLLER_ID || "fc2b25d44a950a6357313da0afb4c14a";

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
  headers.set("Connection", "close");

  const resp = await fetch(url, {
    method: opts.method || "GET",
    headers,
    body: opts.body,
    redirect: "manual",
  });
  const set = parseSetCookie(resp.headers.get("set-cookie"));
  return { resp, jar: mergeCookies(jar, set) };
}

// ---------- helpers ----------
function normMac(mac) {
  const hex = String(mac).replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (hex.length !== 12) return mac;
  return hex.match(/.{1,2}/g).join(":");
}

async function preflightLoginPage(jar = []) {
  const url = `${OMADA_BASE}/${OMADA_CONTROLLER_ID}/hotspot/login?_=${Date.now()}`;
  const { resp, jar: j1 } = await fWithCookies(url, { method: "GET" }, jar);
  // We only need cookies; status 200/302 are both fine.
  await resp.text().catch(() => {});
  return { status: resp.status, jar: j1 };
}

async function getCsrf(jar = []) {
  const url = `${OMADA_BASE}/${OMADA_CONTROLLER_ID}/api/v2/hotspot/csrf?_=${Date.now()}`;
  const { resp, jar: j1 } = await fWithCookies(url, { method: "GET" }, jar);
  const text = await resp.text().catch(() => "");
  let token = null;
  try {
    const j = JSON.parse(text);
    token = j?.result?.token || null;
  } catch {}
  return { status: resp.status, token, raw: text, jar: j1 };
}

// ---------- main ----------
async function hotspotLogin({ site, clientMac, apMac, ssidName, radioId }) {
  let jar = [];

  // 0) Always hit /hotspot/login first (cookies)
  const pre = await preflightLoginPage(jar);
  jar = pre.jar;

  // 1) Try to grab CSRF (may 302/no token; that’s ok)
  const csrf1 = await getCsrf(jar);
  jar = csrf1.jar;

  // 2) POST /api/v2/hotspot/auth (External Portal)
  const body = {
    site,
    clientMac: normMac(clientMac),
    apMac: normMac(apMac),
    ssidName,
    radioId,
  };
  const authUrl = `${OMADA_BASE}/${OMADA_CONTROLLER_ID}/api/v2/hotspot/auth?_=${Date.now()}`;
  const headers = {
    "Content-Type": "application/json",
    // Referer helps some Omada builds
    Referer: `${OMADA_BASE}/${OMADA_CONTROLLER_ID}/hotspot/login`,
    "X-Requested-With": "XMLHttpRequest",
    ...(csrf1.token ? { "Csrf-Token": csrf1.token } : {}),
    "User-Agent": "w2g-splash/2025-08-29",
    Connection: "close",
  };

  let { resp: authResp, jar: j2 } = await fWithCookies(
    authUrl,
    { method: "POST", headers, body: JSON.stringify(body) },
    jar
  );
  jar = j2;

  const authText = await authResp.text().catch(() => "");
  let authData;
  try {
    authData = JSON.parse(authText);
  } catch {
    authData = { errorCode: -1, msg: "Non-JSON auth response", raw: authText };
  }

  // One retry with fresh cookies/CSRF if controller hints session/csrf issue
  if (
    authResp.status >= 500 ||
    authData?.errorCode === -1200 ||
    authData?.errorCode === -30104 ||
    authData?.errorCode === -30105
  ) {
    const pre2 = await preflightLoginPage([]); // fresh jar
    let jar2 = pre2.jar;
    const csrf2 = await getCsrf(jar2);
    jar2 = csrf2.jar;

    const headers2 = {
      "Content-Type": "application/json",
      Referer: `${OMADA_BASE}/${OMADA_CONTROLLER_ID}/hotspot/login`,
      "X-Requested-With": "XMLHttpRequest",
      ...(csrf2.token ? { "Csrf-Token": csrf2.token } : {}),
      "User-Agent": "w2g-splash/2025-08-29",
      Connection: "close",
    };

    const r2 = await fWithCookies(
      authUrl,
      { method: "POST", headers: headers2, body: JSON.stringify(body) },
      jar2
    );
    authResp = r2.resp;
    jar = r2.jar;

    const txt2 = await authResp.text().catch(() => "");
    try {
      authData = JSON.parse(txt2);
    } catch {
      authData = { errorCode: -1, msg: "Non-JSON auth response (retry)", raw: txt2 };
    }
  }

  // 3) Confirm
  const statusUrl = `${OMADA_BASE}/${OMADA_CONTROLLER_ID}/api/v2/hotspot/loginStatus?_=${Date.now()}`;
  const { resp: statusResp, jar: jf } = await fWithCookies(statusUrl, { method: "GET" }, jar);
  jar = jf;

  const statusText = await statusResp.text().catch(() => "");
  let statusData;
  try {
    statusData = JSON.parse(statusText);
  } catch {
    statusData = { errorCode: -1, msg: "Non-JSON status response", raw: statusText };
  }

  return {
    preflight: { status: pre.status },
    csrf: { status: csrf1.status, token: csrf1.token },
    auth: { status: authResp.status, data: authData },
    status: { http: statusResp.status, data: statusData },
    cookies: jar,
  };
}

module.exports = { hotspotLogin, normMac };
