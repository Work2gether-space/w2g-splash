// api/omada_auth_probe.js
// Probes /extPortal/auth with multiple path/body/CSRF/MAC variants.
// Tries:
// - Paths: /api/v2/hotspot/extPortal/auth, /api/v2/portal/extPortal/auth, /api/v2/extPortal/auth
// - CSRF header: Csrf-Token, X-Csrf-Token
// - MAC formats: colons, hyphens, rawhex
// - Body shapes: ssidName vs ssid, optional clientIp & redirectUrl, and an "all_extras" combo

const { macColons, macHyphens, macRaw } = require("../lib/omada_hotspot_client");

const OMADA_BASE = (process.env.OMADA_BASE || "https://omada.work2gether.space").replace(/\/+$/, "");
const CTRL = process.env.OMADA_CONTROLLER_ID || "fc2b25d44a950a6357313da0afb4c14a";

function json(res, code, payload) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

// ---- cookie + request helpers ----
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
  if (!headers.has("User-Agent")) headers.set("User-Agent", "w2g-auth-probe/2025-09-02");
  if (!headers.has("Accept")) headers.set("Accept", "application/json,text/html;q=0.9,*/*;q=0.1");
  headers.set("Connection", "close");
  headers.set("Pragma", "no-cache");
  headers.set("Cache-Control", "no-cache");
  if (!headers.has("Accept-Language")) headers.set("Accept-Language", "en-US,en;q=0.9");
  if (!headers.has("Origin")) headers.set("Origin", OMADA_BASE);
  // IMPORTANT: don't overwrite Referer if caller supplied one
  if (!headers.has("Referer")) headers.set("Referer", `${OMADA_BASE}/${CTRL}/portal`);

  const resp = await fetch(url, {
    method: opts.method || "GET",
    headers,
    body: opts.body,
    redirect: "manual",
  });

  const set = parseSetCookie(resp.headers.get("set-cookie"));
  return { resp, jar: mergeCookies(jar, set) };
}

// ---- warm + operator login ----
async function preflight(jar = []) {
  const url = `${OMADA_BASE}/${CTRL}/hotspot/login?_=${Date.now()}`;
  const { resp, jar: j1 } = await fWithCookies(url, { method: "GET", headers: { Referer: `${OMADA_BASE}/${CTRL}/hotspot/login` } }, jar);
  await resp.text().catch(() => {});
  return { status: resp.status, jar: j1 };
}

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

async function operatorLogin(jar = []) {
  const url = `${OMADA_BASE}/${CTRL}/api/v2/hotspot/login?_=${Date.now()}`;
  const headers = {
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${OMADA_BASE}/${CTRL}/hotspot/login`
  };
  const body = JSON.stringify({ name: process.env.OMADA_OPERATOR_USER, password: process.env.OMADA_OPERATOR_PASS });
  const { resp, jar: j2 } = await fWithCookies(url, { method: "POST", headers, body }, jar);
  const text = await resp.text().catch(() => "");
  const t = extractTokenPieces(resp, text);
  const token = t.bodyToken || t.hdrToken || t.cookieToken || null;
  return { status: resp.status, token, jar: j2, raw: text };
}

// ---- POST /extPortal/auth with variants ----
async function postAuth({ jar, token, path, body, referer, csrfHeaderName }) {
  const url = `${OMADA_BASE}/${CTRL}${path}?_=${Date.now()}`;
  const headers = {
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${OMADA_BASE}/${CTRL}${referer}`
  };
  if (token && csrfHeaderName) headers[csrfHeaderName] = token;

  const { resp, jar: j2 } = await fWithCookies(url, { method: "POST", headers, body: JSON.stringify(body) }, jar);
  const text = await resp.text().catch(() => "");
  let data; try { data = JSON.parse(text); } catch { data = { errorCode: -1, msg: "Non-JSON", raw: text }; }
  return { status: resp.status, data, posted: body, jar: j2 };
}

// ---- small utils ----
function pick(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function normalizeRedirect(url) {
  const s = String(url || "").trim();
  if (!s) return "http://neverssl.com";
  let v = s;
  try { v = decodeURIComponent(s); } catch {}
  if (/captiveportal|connecttest|generate_204|msftconnecttest|wifiportal/i.test(v)) {
    return "http://neverssl.com";
  }
  return v;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Use POST." });

  const b = await readBody(req);

  // Inputs with safe fallbacks and consistent typing (radioId as string)
  const site       = pick(b, "site", "siteId") || "688c13adee75005c5bb411bd";
  const clientMacI = pick(b, "clientMac") || "C8-5E-A9-EE-D9-46";
  const apMacI     = pick(b, "apMac") || "30-68-93-E9-96-AE";
  const ssidName   = pick(b, "ssidName", "ssid") || "W2G_Basic";
  const ssid       = pick(b, "ssid", "ssidName") || "W2G_Basic";
  const radioId    = pick(b, "radioId", "radio") || "1";
  const clientIp   = pick(b, "clientIp") || "192.168.20.109";
  const redirectUrl= normalizeRedirect(pick(b, "redirectUrl") || "http://neverssl.com");

  try {
    // 0) warm + 1) operator login
    let jar = [];
    const pf = await preflight(jar); jar = pf.jar;
    const op = await operatorLogin(jar); jar = op.jar;
    const token = op.token || null;

    // mac variants
    const macs = [
      { fmt: "colons",  cm: macColons(clientMacI), am: macColons(apMacI) },
      { fmt: "hyphens", cm: macHyphens(clientMacI), am: macHyphens(apMacI) },
      { fmt: "rawhex",  cm: macRaw(clientMacI),    am: macRaw(apMacI) },
    ];

    // body shapes
    const shapes = [
      { name: "ssidName_only", build: (cm, am) => ({ site, clientMac: cm, apMac: am, ssidName, radioId }) },
      { name: "ssid_only",     build: (cm, am) => ({ site, clientMac: cm, apMac: am, ssid,     radioId }) },
      { name: "plus_clientIp", build: (cm, am) => ({ site, clientMac: cm, apMac: am, ssidName, radioId, clientIp }) },
      { name: "plus_redirect", build: (cm, am) => ({ site, clientMac: cm, apMac: am, ssidName, radioId, redirectUrl }) },
      { name: "all_extras",    build: (cm, am) => ({ site, clientMac: cm, apMac: am, ssidName, ssid, radioId, clientIp, redirectUrl }) },
    ];

    // path + csrf variants
    const paths = [
      { path: "/api/v2/hotspot/extPortal/auth", referer: "/hotspot/login" },
      { path: "/api/v2/portal/extPortal/auth",  referer: "/portal"        },
      { path: "/api/v2/extPortal/auth",         referer: "/portal"        },
    ];
    const csrfNames = ["Csrf-Token", "X-Csrf-Token"];

    const attempts = [];
    let chosen = null;

    for (const p of paths) {
      for (const m of macs) {
        for (const s of shapes) {
          for (const cName of csrfNames) {
            const body = s.build(m.cm, m.am);
            const r = await postAuth({
              jar,
              token,
              path: p.path,
              body,
              referer: p.referer,
              csrfHeaderName: cName
            });
            attempts.push({
              path: p.path,
              referer: p.referer,
              macFormat: m.fmt,
              shape: s.name,
              csrfHeader: cName,
              http: r.status,
              data: r.data,
              posted: r.posted,
            });
            jar = r.jar;

            if (r.data && Number(r.data.errorCode) === 0) {
              chosen = attempts[attempts.length - 1];
              break;
            }
          }
          if (chosen) break;
        }
        if (chosen) break;
      }
      if (chosen) break;
    }

    return json(res, 200, {
      ok: Boolean(chosen),
      mode: "extPortal auth probe",
      input: { site, clientMac: clientMacI, apMac: apMacI, ssid, ssidName, radioId, clientIp, redirectUrl },
      operatorLogin: { status: op.status, token: !!token },
      attempts,
      chosen,
    });
  } catch (e) {
    return json(res, 200, { ok: false, error: e?.message || String(e) });
  }
};
