console.log("DEBUG: authorize.js build version 2025-08-11a");


// api/authorize.js  (Vercel Serverless Function - CommonJS with dynamic ESM import)
const axios = require("axios").default;
const tough = require("tough-cookie");
const https = require("https");

const BUILD_VERSION = "2025-08-11b";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Use POST" });
    return;
  }

  console.log("DEBUG: authorize.js build version", BUILD_VERSION);

  // 🔧 ESM-only module; load it at runtime from CommonJS:
  let wrapper;
  try {
    ({ wrapper } = await import("axios-cookiejar-support"));
  } catch (e) {
    console.error("Failed to import axios-cookiejar-support (ESM):", e);
    res.status(500).json({ ok: false, error: "esm_import_failed", detail: String(e) });
    return;
  }

  try {
    const {
      OMADA_BASE,              // e.g. https://98.114.198.237:9444  (Controller HTTPS)
      OMADA_CONTROLLER_ID,     // default 'omadac' on OC200
      OMADA_OPERATOR_USER,
      OMADA_OPERATOR_PASS,
      SESSION_MINUTES = "240"
    } = process.env;

    if (!OMADA_BASE || !OMADA_OPERATOR_USER || !OMADA_OPERATOR_PASS) {
      console.error("ENV MISSING", {
        OMADA_BASE: !!OMADA_BASE,
        OMADA_OPERATOR_USER: !!OMADA_OPERATOR_USER,
        OMADA_OPERATOR_PASS: !!OMADA_OPERATOR_PASS
      });
      res.status(500).json({ ok: false, error: "Missing OMADA_* env vars" });
      return;
    }

    const controllerId = (OMADA_CONTROLLER_ID && OMADA_CONTROLLER_ID.trim()) || "omadac";
    const base = `${OMADA_BASE.replace(/\/$/, "")}/${controllerId}`;

    const { clientMac, apMac, ssidName, radioId, site, redirectUrl } = req.body || {};
    if (!clientMac || !site) {
      console.error("REQUEST MISSING", { clientMac, site, body: req.body });
      res.status(400).json({ ok: false, error: "Missing clientMac or site" });
      return;
    }

    // Accept self-signed cert + keep cookies
    const agent = new https.Agent({ rejectUnauthorized: false });
    const jar = new tough.CookieJar();
    const http = wrapper(axios.create({
      jar,
      withCredentials: true,
      timeout: 15000,
      httpsAgent: agent
    }));

    // 1) Hotspot login -> CSRF token
    let login;
    try {
      login = await http.post(`${base}/api/v2/hotspot/login`, {
        name: OMADA_OPERATOR_USER,
        password: OMADA_OPERATOR_PASS
      }, {
        headers: { "Content-Type": "application/json", "Accept": "application/json" }
      });
    } catch (e) {
      const data = e?.response?.data || e.message || e;
      console.error("LOGIN HTTP ERROR:", data);
      res.status(502).json({ ok: false, step: "login", error: "HTTP error", detail: data });
      return;
    }

    if (!login.data || login.data.errorCode !== 0) {
      console.error("LOGIN FAILED:", login.data);
      res.status(502).json({ ok: false, step: "login", error: "Hotspot login failed", detail: login.data });
      return;
    }

    const csrf = login.data.result?.token;
    if (!csrf) {
      console.error("LOGIN NO TOKEN:", login.data);
      res.status(502).json({ ok: false, step: "login", error: "No CSRF token", detail: login.data });
      return;
    }

    // 2) Authorize client
    const timeMicros = String(BigInt(SESSION_MINUTES) * 60n * 1000000n);
    const payload = {
      clientMac,
      apMac,
      ssidName,
      radioId: radioId ? Number(radioId) : 1,
      site,
      time: timeMicros,
      authType: 4
    };

    let auth;
    try {
      auth = await http.post(`${base}/api/v2/hotspot/extPortal/auth`, payload, {
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Csrf-Token": csrf
        }
      });
    } catch (e) {
      const data = e?.response?.data || e.message || e;
      console.error("AUTH HTTP ERROR:", data);
      res.status(502).json({ ok: false, step: "auth", error: "HTTP error", detail: data });
      return;
    }

    if (!auth.data || auth.data.errorCode !== 0) {
      console.error("AUTH FAILED:", auth.data);
      res.status(502).json({ ok: false, step: "auth", error: "Authorization failed", detail: auth.data });
      return;
    }

    console.log("AUTH OK:", { site, clientMac, apMac, ssidName });
    res.json({ ok: true, redirectUrl: redirectUrl || "http://neverssl.com" });
  } catch (err) {
    const detail = err?.response?.data || err.message || err;
    console.error("authorize fatal error:", detail);
    res.status(500).json({ ok: false, error: "Internal error", detail });
  }
};
