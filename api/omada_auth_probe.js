// api/omada_auth_probe.js
// Probes /api/v2/hotspot/extPortal/auth with multiple body shapes:
// - ssidName vs ssid
// - optional clientIp and redirectUrl
// - MAC formats: colons, hyphens, rawhex
//
// Uses the same shared client helpers/headers as our new flow.

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
  if (!headers.has("User-Agent")) headers.set("User-Agent", "w2g-auth-probe/2025-08-29");
  headers.set("Accept", "application/json,text/html;q=0.9,*/*;q=0.1");
  headers.set("Connection", "close");
  headers.set("Pragma", "no-cache");
  headers.set("Cache-Control", "no-cache");
  headers.set("Accept-Language", "en-US,en;q=0.9");
  headers.set("Origin", OMADA_BASE);
  headers.set("Referer", `${OMADA_BASE}/${CTRL}/portal`);
  const resp = await fetch(url, {
    method: opts.method || "GET",
    headers, body: opts.body, redirect: "manual",
  });
  const set = parseSetCookie(resp.headers.get("set-cookie"));
  return { resp, jar: mergeCookies(jar, set) };
}

async function preflight(jar=[]) {
  const url = `${OMADA_BASE}/${CTRL}/hotspot/login?_=${Date.now()}`;
  const { resp, jar: j1 } = await fWithCookies(url, { method: "GET" }, jar);
  await resp.text().catch(()=>{});
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
  const m = String(sc).match(/csrf[-_]?token=([^;]+)/i) || String(sc).match(/x[-_]?csrf[-_]?token=([^;]+)/i) || String(sc).match(/portal[-_]?csrf=([^;]+)/i);
  const cookieToken = m ? m[1] : null;
  return { bodyToken, hdrToken, cookieToken };
}

async function operatorLogin(jar=[]) {
  const url = `${OMADA_BASE}/${CTRL}/api/v2/hotspot/login?_=${Date.now()}`;
  const headers = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Referer: `${OMADA_BASE}/${CTRL}/portal` };
  const body = JSON.stringify({ name: process.env.OMADA_OPERATOR_USER, password: process.env.OMADA_OPERATOR_PASS });
  const { resp, jar: j2 } = await fWithCookies(url, { method: "POST", headers, body }, jar);
  const text = await resp.text().catch(()=> "");
  const t = extractTokenPieces(resp, text);
  const token = t.bodyToken || t.hdrToken || t.cookieToken || null;
  return { status: resp.status, token, jar: j2, raw: text };
}

async function postAuth(jar=[], token, body) {
  const url = `${OMADA_BASE}/${CTRL}/api/v2/hotspot/extPortal/auth?_=${Date.now()}`;
  const headers = {
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${OMADA_BASE}/${CTRL}/hotspot/login`,
    ...(token ? { "Csrf-Token": token } : {}),
  };
  const { resp, jar: j2 } = await fWithCookies(url, { method: "POST", headers, body: JSON.stringify(body) }, jar);
  const text = await resp.text().catch(()=> "");
  let data; try { data = JSON.parse(text); } catch { data = { errorCode:-1, msg:"Non-JSON", raw:text }; }
  return { status: resp.status, data, posted: body, jar: j2 };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { ok:false, error:"Use POST." });
  const b = await readBody(req);

  const site = b.site || "688c13adee75005c5bb411bd";
  const clientMac = b.clientMac || "C8-5E-A9-EE-D9-46";
  const apMac = b.apMac || "30-68-93-E9-96-AE";
  const ssid = b.ssid || "W2G_Basic";
  const ssidName = b.ssidName || "W2G_Basic";
  const radioId = b.radioId ?? 0;
  const clientIp = b.clientIp || "192.168.20.109";
  const redirectUrl = b.redirectUrl || "http://neverssl.com";

  try {
    // 0) warm + 1) operator login
    let jar = [];
    const pf = await preflight(jar); jar = pf.jar;
    const op = await operatorLogin(jar); jar = op.jar; const token = op.token || null;

    // mac variants
    const v = [
      { fmt:"colons",  cm: macColons(clientMac), am: macColons(apMac) },
      { fmt:"hyphens", cm: macHyphens(clientMac), am: macHyphens(apMac) },
      { fmt:"rawhex",  cm: macRaw(clientMac),    am: macRaw(apMac) },
    ];

    // body shapes
    const shapes = [
      { name:"ssidName_only", build:(cm,am)=>({ site, clientMac:cm, apMac:am, ssidName, radioId }) },
      { name:"ssidName_plus_clientIp", build:(cm,am)=>({ site, clientMac:cm, apMac:am, ssidName, radioId, clientIp }) },
      { name:"ssidName_plus_redirect", build:(cm,am)=>({ site, clientMac:cm, apMac:am, ssidName, radioId, redirectUrl }) },
      { name:"ssid_and_ssidName", build:(cm,am)=>({ site, clientMac:cm, apMac:am, ssidName, ssid, radioId }) },
      { name:"ssid_only", build:(cm,am)=>({ site, clientMac:cm, apMac:am, ssid, radioId }) },
      { name:"all_extras", build:(cm,am)=>({ site, clientMac:cm, apMac:am, ssidName, ssid, radioId, clientIp, redirectUrl }) },
    ];

    const attempts = [];
    let chosen = null;

    for (const m of v) {
      for (const s of shapes) {
        const body = s.build(m.cm, m.am);
        const r = await postAuth(jar, token, body);
        attempts.push({ macFormat:m.fmt, shape:s.name, http:r.status, data:r.data, posted:r.posted });
        if (r.data && r.data.errorCode === 0) {
          chosen = { macFormat:m.fmt, shape:s.name, http:r.status, data:r.data, posted:r.posted };
          break;
        }
      }
      if (chosen) break;
    }

    return json(res, 200, {
      ok: !!chosen,
      mode: "extPortal auth probe",
      input: { site, clientMac, apMac, ssid, ssidName, radioId, clientIp, redirectUrl },
      operatorLogin: { status: op.status, token: !!token },
      attempts,
      chosen,
    });
  } catch (e) {
    return json(res, 200, { ok:false, error: e?.message || String(e) });
  }
};
