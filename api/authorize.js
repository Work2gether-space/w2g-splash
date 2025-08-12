console.log("DEBUG: authorize.js build version 2025-08-11a");

// api/authorize.js  (Vercel Serverless Function - CommonJS)
const axios = require("axios").default;
const { CookieJar } = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");
const https = require("https");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Use POST" });
    return;
  }

  // Required env
  const {
    OMADA_BASE,              // e.g. https://98.114.198.237:9443  public controller URL that shows the Omada login page
    OMADA_CONTROLLER_ID,     // 32 char controller id, e.g. fc2b25d44a950a6357313da0afb4c14a
    OMADA_OPERATOR_USER,     // operator username
    OMADA_OPERATOR_PASS,     // operator password
    SESSION_MINUTES = "1440" // default 24 hours
  } = process.env;

  if (!OMADA_BASE || !OMADA_CONTROLLER_ID || !OMADA_OPERATOR_USER || !OMADA_OPERATOR_PASS) {
    res.status(500).json({ ok: false, error: "Missing env vars OMADA_BASE, OMADA_CONTROLLER_ID, OMADA_OPERATOR_USER, OMADA_OPERATOR_PASS" });
    return;
  }

  const { clientMac, apMac, ssidName, radioId, site, redirectUrl } = req.body || {};
  if (!clientMac || !site) {
    res.status(400).json({ ok: false, error: "Missing clientMac or site" });
    return;
  }

  const norm = (s) => s.replace(/\/+$/,"");
  const BASE = norm(OMADA_BASE);
  const CONTROLLER_ID = OMADA_CONTROLLER_ID;

  const LOGIN_URL = `${BASE}/${CONTROLLER_ID}/api/v2/hotspot/login`;
  const AUTH_URL  = `${BASE}/${CONTROLLER_ID}/api/v2/hotspot/extPortal/auth`;

  const agent = new https.Agent({ rejectUnauthorized: false }); // accept self-signed
  const jar = new CookieJar();
  const http = wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 12000,
    httpsAgent: agent,
    headers: { "Accept": "application/json", "Content-Type": "application/json" }
  }));

  // loud logs
  console.info("[authorize] LOGIN try:", LOGIN_URL);

  // 1) Login to hotspot to obtain CSRF token and cookies
  let csrf = null;
  try {
    // Omada expects username and password keys
    const r = await http.post(LOGIN_URL, {
      username: OMADA_OPERATOR_USER,
      password: OMADA_OPERATOR_PASS
    });

    // Try header first, then body token
    csrf =
      r.headers?.["csrf-token"] ||
      r.headers?.["Csrf-Token"] ||
      r.data?.result?.token ||
      null;

    if (!csrf) {
      console.error("[authorize] LOGIN ok but no CSRF token found. Resp keys:", Object.keys(r.headers || {}), Object.keys(r.data || {}));
      res.status(502).json({ ok: false, error: "Login returned no CSRF token" });
      return;
    }
  } catch (e) {
    const detail = e?.response?.data || e?.message || "unknown";
    console.error("[authorize] LOGIN failed detail:", detail);
    res.status(502).json({ ok: false, error: "Hotspot login failed", detail });
    return;
  }

  // 2) Authorize client
  try {
    const timeMs = String(parseInt(SESSION_MINUTES, 10) * 60 * 1000); // milliseconds
    const payload = {
      clientMac,
      apMac,
      ssidName,
      radioId: radioId ? Number(radioId) : 1,
      site,
      time: timeMs,
      authType: 4
    };

    console.info("[authorize] AUTH try:", AUTH_URL, "payload:", { ...payload, clientMac: "(present)", apMac: "(present)" });

    const auth = await http.post(AUTH_URL, payload, {
      headers: {
        "Csrf-Token": csrf
      }
    });

    if (auth?.data?.errorCode !== 0) {
      console.error("[authorize] AUTH failed:", auth?.data);
      res.status(502).json({ ok: false, error: "Authorization failed", detail: auth?.data });
      return;
    }

    res.json({ ok: true, redirectUrl: redirectUrl || "http://neverssl.com" });
  } catch (e) {
    const detail = e?.response?.data || e?.message || "unknown";
    console.error("[authorize] AUTH error:", detail);
    res.status(500).json({ ok: false, error: e?.message || "Internal error", detail });
  }
};

