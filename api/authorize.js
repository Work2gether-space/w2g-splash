// api/authorize.js
// Build: 2025-09-02-ext-portal-a
// Purpose: If ssidName === "W2G_Basic" (External Portal), call extPortal/auth (not hotspot/login)

export default async function handler(req, res) {
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const log = (...a) => console.log(`[authorize][${rid}]`, ...a);
  const err = (...a) => console.error(`[authorize][${rid}]`, ...a);

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Use POST" });
    return;
  }

  // --- Inputs we already saw in your logs ---
  const body = typeof req.body === "object" ? req.body : {};
  const {
    clientMac,
    apMac,
    ssidName,
    radioId,
    redirectUrl,
    siteId,
    siteName,
    email,
    extend,
    dbgProbe,
  } = body;

  // --- Omada env vars ---
  const OMADA_BASE = String(process.env.OMADA_BASE || "https://omada.work2gether.space").replace(/\/+$/, "");
  const CTRL = process.env.OMADA_CONTROLLER_ID || "fc2b25d44a950a6357313da0afb4c14a";
  const OP_USER = process.env.OMADA_OPERATOR_USER;
  const OP_PASS = process.env.OMADA_OPERATOR_PASS;

  // quick sanity
  if (!OMADA_BASE || !CTRL || !OP_USER || !OP_PASS) {
    return res.status(500).json({
      ok: false,
      error: "Missing Omada env vars",
      present: {
        OMADA_BASE: !!OMADA_BASE,
        OMADA_CONTROLLER_ID: !!CTRL,
        OMADA_OPERATOR_USER: !!OP_USER,
        OMADA_OPERATOR_PASS: !!OP_PASS,
      },
    });
  }

  // helpers
  const hkeys = (h = {}) => Object.keys(h || {}).map(k => k.toLowerCase()).sort();
  const parseSetCookie = (h) => {
    const out = [];
    if (!h) return out;
    const arr = Array.isArray(h) ? h : [h];
    for (const line of arr) {
      const kv = String(line).split(";")[0].trim();
      if (kv.includes("=")) out.push(kv);
    }
    return out;
  };
  const mergeCookies = (a, b) => {
    const m = new Map();
    for (const c of [...(a || []), ...(b || [])]) {
      const [n, ...r] = String(c).split("=");
      m.set(n.trim(), `${n.trim()}=${r.join("=")}`);
    }
    return [...m.values()];
  };
  const macColons = (mac) => {
    const hex = String(mac || "").replace(/[^0-9a-f]/gi, "").toUpperCase();
    if (hex.length !== 12) return mac || "";
    return hex.match(/.{1,2}/g).join(":");
  };

  // fetch with a tiny cookie jar
  async function fWithCookies(url, opts = {}, jar = []) {
    const headers = new Headers(opts.headers || {});
    if (jar.length) headers.set("Cookie", jar.join("; "));
    // browser-ish
    headers.set("User-Agent", "w2g-authorize/2025-09-02");
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
      redirect: "manual", // IMPORTANT: we want to see 302 from extPortal/auth
    });

    const set = parseSetCookie(resp.headers.get("set-cookie"));
    return { resp, jar: mergeCookies(jar, set) };
  }

  async function operatorLogin(jar = []) {
    const url = `${OMADA_BASE}/${CTRL}/api/v2/hotspot/login?_=${Date.now()}`;
    const headers = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };
    const body = JSON.stringify({ name: OP_USER, password: OP_PASS });

    const { resp, jar: j2 } = await fWithCookies(url, { method: "POST", headers, body }, jar);
    const text = await resp.text().catch(() => "");
    let token = null;
    try { const j = JSON.parse(text); token = j?.result?.token || j?.token || null; } catch {}
    const hdr = resp.headers.get("csrf-token") || resp.headers.get("x-csrf-token") || null;
    token = token || hdr || null;

    return { status: resp.status, token, raw: text, jar: j2, headerKeys: hkeys(Object.fromEntries(resp.headers)) };
  }

  // --- MAIN ---
  try {
    // Branch: only W2G_Basic goes through External Portal path.
    const isExternalPortal = String(ssidName || "").trim() === "W2G_Basic";

    if (!isExternalPortal) {
      // (Unchanged behavior for other SSIDs; keep simple pass-through here)
      return res.status(200).json({
        ok: false,
        error: "This build only patches External-Portal path for W2G_Basic. SSID is not W2G_Basic.",
        ssidName,
      });
    }

    // Normalize fields Omada expects
    const cmac = macColons(clientMac);
    const amap = macColons(apMac);
    const rId = (Number.isInteger(radioId) ? radioId : parseInt(radioId || "0", 10)) || 0;
    const redir = redirectUrl || "http://neverssl.com";

    if (!cmac) {
      return res.status(400).json({ ok: false, error: "Missing clientMac" });
    }

    // 0) Warm hotspot page (Omada sometimes sets baseline cookies here)
    let jar = [];
    const warm = await fWithCookies(`${OMADA_BASE}/${CTRL}/hotspot/login?_=${Date.now()}`, { method: "GET" }, jar);
    jar = warm.jar; await warm.resp.text().catch(() => {});

    // 1) Login as operator to obtain session + possible CSRF
    const op = await operatorLogin(jar);
    jar = op.jar;
    const token = op.token || null;

    // 2) External-Portal allow (GET with query params). Success is either:
    //    - HTTP 200 + JSON {errorCode:0}
    //    - HTTP 302 (Found) redirecting to /hotspot/login (Omada often uses this on success)
    const q = new URLSearchParams();
    q.set("clientMac", cmac);
    if (amap) q.set("apMac", amap);
    if (ssidName) q.set("ssidName", ssidName);
    q.set("radioId", String(rId));
    q.set("authResult", "1");
    q.set("redirectUrl", redir);

    const authUrl = `${OMADA_BASE}/${CTRL}/api/v2/hotspot/extPortal/auth?${q.toString()}&_=${Date.now()}`;
    const headers = {
      ...(token ? { "Csrf-Token": token } : {}),
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${OMADA_BASE}/${CTRL}/hotspot/login`,
    };
    const rAuth = await fWithCookies(authUrl, { method: "GET", headers }, jar);
    jar = rAuth.jar;
    const authText = await rAuth.resp.text().catch(() => "");
    let authJson = null; try { authJson = JSON.parse(authText); } catch {}
    const authStatus = rAuth.resp.status;

    const successByJson = !!(authJson && authJson.errorCode === 0);
    const successByRedirect = authStatus === 302; // common success path in External Portal

    if (!successByJson && !successByRedirect) {
      return res.status(200).json({
        ok: false,
        error: "External portal allow did not succeed",
        ssidName,
        attempt: {
          method: "GET",
          url: `/extPortal/auth?${q.toString()}`,
          http: authStatus,
          json: authJson,
          setCookieCount: jar.length,
        },
        operatorLogin: { status: op.status, tokenPresent: !!token },
      });
    }

    // 3) Optional: check loginStatus (without token it may still show login:false; success criteria is extPortal step above)
    const loginStatusUrl = `${OMADA_BASE}/${CTRL}/api/v2/hotspot/loginStatus?_=${Date.now()}`;
    const rStatus = await fWithCookies(loginStatusUrl, { method: "GET" }, jar);
    const statusText = await rStatus.resp.text().catch(() => "");
    let statusJson = null; try { statusJson = JSON.parse(statusText); } catch {}
    // Do not fail on this; many builds need token param. We still include for visibility.

    // 4) Return success to splash with same redirect the controller expects.
    return res.status(200).json({
      ok: true,
      mode: "external-portal-allow",
      ssidName,
      clientMac: cmac,
      apMac: amap || null,
      radioId: rId,
      redirectUrl: redir,
      omada: {
        operatorLogin: { status: op.status, tokenPresent: !!token },
        extPortalAuth: {
          http: authStatus,
          successByJson,
          successByRedirect,
          json: authJson || null,
        },
        loginStatusEcho: { http: rStatus.resp.status, json: statusJson || null },
      },
      message: "External portal allow submitted; client should be released by controller.",
    });
  } catch (e) {
    err("authorize error:", e?.stack || e);
    return res.status(502).json({ ok: false, error: String(e?.message || e) });
  }
}
