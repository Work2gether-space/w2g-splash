// api/omada_ext_auth_min.js
// Build: 2025-09-04-3.5e-cloudflared
// EXTREMELY MINIMAL extPortal/auth probe with small variants
// Tries: path variants, CSRF header variants, MAC formats, form vs JSON payloads
// Change: OMADA_BASE now defaults to the Cloudflared tunnel host.

const OMADA_BASE = String(process.env.OMADA_BASE || "https://omada-direct.work2gether.space").replace(/\/+$/, "");
const CTRL = process.env.OMADA_CONTROLLER_ID || "fc2b25d44a950a6357313da0afb4c14a";
const OP_USER = process.env.OMADA_OPERATOR_USER;
const OP_PASS = process.env.OMADA_OPERATOR_PASS;

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch { resolve({}); }
    });
  });
}

// cookies
function parseSetCookie(h) {
  const out = [];
  if (!h) return out;
  const arr = Array.isArray(h) ? h : [h];
  for (const line of arr) {
    const kv = String(line).split(";")[0].trim();
    if (kv.includes("=")) out.push(kv);
  }
  return out;
}
function mergeCookies(a, b) {
  const m = new Map();
  for (const c of [...a, ...b]) {
    const [n, ...r] = String(c).split("=");
    m.set(n.trim(), `${n.trim()}=${r.join("=")}`);
  }
  return [...m.values()];
}
async function fWithCookies(url, opts = {}, jar = []) {
  const headers = new Headers(opts.headers || {});
  if (jar.length) headers.set("Cookie", jar.join("; "));
  if (!headers.has("User-Agent")) headers.set("User-Agent", "w2g-ext-auth-min/2025-09-04");
  if (!headers.has("Accept")) headers.set("Accept", "application/json,text/html;q=0.9,*/*;q=0.1");
  headers.set("Connection", "close");
  headers.set("Pragma", "no-cache");
  headers.set("Cache-Control", "no-cache");
  if (!headers.has("Accept-Language")) headers.set("Accept-Language", "en-US,en;q=0.9");
  if (!headers.has("Origin")) headers.set("Origin", OMADA_BASE);
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

// MAC helpers
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

// token
async function operatorLogin(jar = []) {
  const url = `${OMADA_BASE}/${CTRL}/api/v2/hotspot/login?_=${Date.now()}`;
  const headers = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };
  const body = JSON.stringify({ name: OP_USER, password: OP_PASS });
  const { resp, jar: j2 } = await fWithCookies(url, { method: "POST", headers, body }, jar);
  const text = await resp.text().catch(() => "");
  let bodyToken = null;
  try { const j = JSON.parse(text); bodyToken = j?.result?.token || j?.token || null; } catch {}
  const hdrToken = resp.headers.get("csrf-token") || resp.headers.get("x-csrf-token") || null;
  return { status: resp.status, token: bodyToken || hdrToken || null, raw: text, jar: j2 };
}

// pick helper
function pick(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

// payload builders
function buildFormMinimal(clientMac) {
  const form = new URLSearchParams();
  form.set("clientMac", clientMac);
  form.set("authResult", "1");
  return form;
}
function buildFormFull({ clientMac, apMac, ssidName, radioId, site }) {
  const form = new URLSearchParams();
  form.set("clientMac", clientMac);
  if (apMac) form.set("apMac", apMac);
  if (ssidName) form.set("ssidName", ssidName);
  if (radioId) form.set("radioId", radioId);
  if (site) form.set("site", site);
  form.set("authResult", "1");
  return form;
}
function buildJsonFull({ clientMac, apMac, ssidName, radioId, site }) {
  const obj = { clientMac, authResult: 1 };
  if (apMac) obj.apMac = apMac;
  if (ssidName) obj.ssidName = ssidName;
  if (radioId) obj.radioId = radioId;
  if (site) obj.site = site;
  return JSON.stringify(obj);
}

export default async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "Use POST." });
  if (!OP_USER || !OP_PASS) {
    return send(res, 500, {
      ok: false,
      error: "Missing OMADA_OPERATOR_USER or OMADA_OPERATOR_PASS",
      omadaBase: OMADA_BASE,
    });
  }

  const b = await readBody(req);

  // inputs with fallbacks
  const clientMacIn = pick(b, "clientMac") || "C8-5E-A9-EE-D9-46";
  const apMacIn = pick(b, "apMac");
  const ssidNameIn = pick(b, "ssidName", "ssid");
  const radioIdIn = pick(b, "radioId", "radio");
  const siteIn = pick(b, "site", "siteId");

  // MAC variants
  const macs = [
    { name: "colons", clientMac: macColons(clientMacIn), apMac: apMacIn ? macColons(apMacIn) : "" },
    { name: "hyphens", clientMac: macHyphens(clientMacIn), apMac: apMacIn ? macHyphens(apMacIn) : "" },
    { name: "rawhex", clientMac: macRaw(clientMacIn), apMac: apMacIn ? macRaw(apMacIn) : "" },
  ];

  // path variants
  const paths = [
    { path: "/api/v2/hotspot/extPortal/auth", referer: "/hotspot/login" },
    { path: "/api/v2/portal/extPortal/auth",  referer: "/portal"        },
    { path: "/api/v2/extPortal/auth",         referer: "/portal"        },
  ];

  // csrf header variants
  const csrfNames = ["Csrf-Token", "X-Csrf-Token", ""];

  // content types
  const bodies = [
    { kind: "form_min",  ctype: "application/x-www-form-urlencoded" },
    { kind: "form_full", ctype: "application/x-www-form-urlencoded" },
    { kind: "json_full", ctype: "application/json" },
  ];

  try {
    // warm
    let jar = [];
    const warm = await fWithCookies(`${OMADA_BASE}/${CTRL}/hotspot/login?_=${Date.now()}`, { method: "GET" }, jar);
    jar = warm.jar; await warm.resp.text().catch(() => {});

    // login
    const op = await operatorLogin(jar);
    jar = op.jar;
    const token = op.token || null;

    const attempts = [];
    let chosen = null;

    // try a small matrix
    for (const p of paths) {
      for (const m of macs) {
        for (const bdef of bodies) {
          for (const csrfName of csrfNames) {
            const url = `${OMADA_BASE}/${CTRL}${p.path}?_=${Date.now()}`;

            let body;
            if (bdef.kind === "form_min") {
              body = buildFormMinimal(m.clientMac).toString();
            } else if (bdef.kind === "form_full") {
              body = buildFormFull({
                clientMac: m.clientMac,
                apMac: m.apMac,
                ssidName: ssidNameIn,
                radioId: radioIdIn,
                site: siteIn
              }).toString();
            } else {
              body = buildJsonFull({
                clientMac: m.clientMac,
                apMac: m.apMac,
                ssidName: ssidNameIn,
                radioId: radioIdIn,
                site: siteIn
              });
            }

            const headers = {
              "Content-Type": bdef.ctype,
              "X-Requested-With": "XMLHttpRequest",
              Referer: `${OMADA_BASE}/${CTRL}${p.referer}`
            };
            if (token && csrfName) headers[csrfName] = token;

            const r = await fWithCookies(url, { method: "POST", headers, body }, jar);
            const text = await r.resp.text().catch(() => "");
            let data;
            try { data = JSON.parse(text); } catch { data = { errorCode: -1, msg: "Non-JSON", raw: text }; }

            const rec = {
              path: p.path,
              referer: p.referer,
              macVariant: m.name,
              bodyKind: bdef.kind,
              csrfHeader: csrfName || "<none>",
              http: r.resp.status,
              data,
              postedPreview: bdef.kind === "json_full" ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body).entries())
            };
            attempts.push(rec);
            jar = r.jar;

            if (Number(data?.errorCode) === 0 || r.resp.status === 302) {
              chosen = rec;
              break;
            }
          }
          if (chosen) break;
        }
        if (chosen) break;
      }
      if (chosen) break;
    }

    return send(res, 200, {
      ok: Boolean(chosen),
      omadaBase: OMADA_BASE,
      input: {
        clientMac: clientMacIn,
        apMac: apMacIn || "",
        ssidName: ssidNameIn || "",
        radioId: radioIdIn || "",
        site: siteIn || ""
      },
      operatorLogin: { status: op.status, token: !!token },
      chosen,
      attempts
    });
  } catch (e) {
    return send(res, 200, { ok: false, omadaBase: OMADA_BASE, error: e?.message || String(e) });
  }
};
