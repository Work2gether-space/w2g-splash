// lib/omada_hotspot_client.js
// Node 18+ (Vercel) — no external deps.
// Establishes Omada hotspot session reliably: /hotspot/login -> /api/v2/hotspot/csrf -> /api/v2/hotspot/login.

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
  // Helps with some CF/Omada quirks
  if (!headers.has("User-Agent")) headers.set("User-Agent", "w2g-splash/2025-08-29");
  headers.set("Connection", "close");

  const resp = await fetch(url, {
    method: opts.method || "GET",
    headers,
    body: opts.body,
    redirect: "manual", // we manage cookies across redirects
  });
  const set = parseSetCookie(resp.headers.get("set-cookie"));
  return { resp, jar: mergeCookies(jar, set) };
}

// ---------- helpers ----------
function normMac(mac) {
  const hex = mac.replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (hex.length !== 12) return mac;
  return hex.match(/.{1,2}/g).join(":");
}

async function getLoginPage(site, jar = []) {
  const url = `${OMADA_BASE}/${OMADA_CONTROLLER_ID}/hotspot/login?_=${Date.now()}`;
  const { resp, jar: j1 } = await fWithCookies(url, { method: "GET" }, jar);
  // If 302, it’s fine — we only need cookies. If 200, also fine.
  await resp.text().catch(() => {});
  return { status: resp.status, jar: j1 };
}

async function getCsrf(site, jar = []) {
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

// ---------- main exported op ----------
async function hotspotLogin({ site, clientMac, apMac, ssidName, radioId }) {
  let jar = [];

  // 0) Always touch /hotspot/login first to get server-issued cookies
  const pre = await getLoginPage(site, jar);
  jar = pre.jar;

  // 1) Now fetch CSRF with those cookies
  const csrf1 = await getCsrf(site, jar);
  jar = csrf1.jar;

  // 2) POST /api/v2/hotspot/login with CSRF + cookies
  const payload = {
    site,
    clientMac: normMac(clientMac),
    apMac: normMac(apMac),
    ssidName,
    radioId,
    authType: 4, // MAC auth (matches your working trace)
  };
  const loginUrl = `${OMADA_BASE}/${OMADA_CONTROLLER_ID}/api/v2/hotspot/login?_=${Date.now()}`;
  const headers = {
    "Content-Type": "application/json",
    ...(csrf1.token ? { "Csrf-Token": csrf1.token } : {}),
    "User-Agent": "w2g-splash/2025-08-29",
    Connection: "close",
  };
  let { resp: loginResp, jar: j2 } = await fWithCookies(
    loginUrl,
    { method: "POST", headers, body: JSON.stringify(payload) },
    jar
  );
  jar = j2;
  let loginData;
  const loginText = await loginResp.text().catch(() => "");
  try {
    loginData = JSON.parse(loginText);
  } catch {
    loginData = { errorCode: -1, msg: "Non-JSON login", raw: loginText };
  }

  // 2b) One retry: some controllers need a fresh CSRF after preflight
  if (
    loginResp.status >= 500 ||
    loginData?.errorCode === -1200 ||
    loginData?.errorCode === -30104 ||
    !loginData?.errorCode
  ) {
    const csrf2 = await getCsrf(site, []);
    const headers2 = {
      "Content-Type": "application/json",
      ...(csrf2.token ? { "Csrf-Token": csrf2.token } : {}),
      "User-Agent": "w2g-splash/2025-08-29",
      Connection: "close",
    };
    ({ resp: loginResp, jar: j2 } = await fWithCookies(
      loginUrl,
      { method: "POST", headers: headers2, body: JSON.stringify(payload) },
      csrf2.jar
    ));
    jar = j2;
    const retryText = await loginResp.text().catch(() => "");
    try {
      loginData = JSON.parse(retryText);
    } catch {
      loginData = { errorCode: -1, msg: "Non-JSON login (retry)", raw: retryText };
    }
  }

  // 3) Confirm
  const statusUrl = `${OMADA_BASE}/${OMADA_CONTROLLER_ID}/api/v2/hotspot/loginStatus?_=${Date.now()}`;
  const { resp: statusResp, jar: jf } = await fWithCookies(statusUrl, { method: "GET" }, jar);
  jar = jf;
  let statusData;
  const statusText = await statusResp.text().catch(() => "");
  try {
    statusData = JSON.parse(statusText);
  } catch {
    statusData = { errorCode: -1, msg: "Non-JSON status", raw: statusText };
  }

  return {
    preflight: { status: pre.status },
    csrf: { status: csrf1.status, token: csrf1.token },
    login: { status: loginResp.status, data: loginData },
    status: { http: statusResp.status, data: statusData },
    cookies: jar,
  };
}

module.exports = { hotspotLogin, normMac };
