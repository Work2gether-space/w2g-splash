// api/authorize.js  (Vercel Serverless Function - CommonJS)
const axios = require("axios");
const { CookieJar } = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");
const https = require("https");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Use POST" });
    return;
  }

  try {
    const {
      OMADA_BASE,           // e.g. https://98.114.198.237:9444
      OMADA_CONTROLLER_ID,  // usually "omadac" on OC200 (confirm in your portal)
      OMADA_OPERATOR_USER,  // hotspot operator username
      OMADA_OPERATOR_PASS,  // hotspot operator password
      SESSION_MINUTES = "240",
    } = process.env;

    if (!OMADA_BASE || !OMADA_CONTROLLER_ID || !OMADA_OPERATOR_USER || !OMADA_OPERATOR_PASS) {
      res.status(500).json({ ok: false, error: "Missing env vars" });
      return;
    }

    const { clientMac, apMac, ssidName, radioId, site, redirectUrl } = req.body || {};
    if (!clientMac || !site) {
      res.status(400).json({ ok: false, error: "Missing clientMac or site" });
      return;
    }

    // Build base like: https://PUBLIC_IP:9444/omadac
    const base = `${OMADA_BASE.replace(/\/$/, "")}/${OMADA_CONTROLLER_ID}`;

    // Accept self-signed cert on OC200
    const agent = new https.Agent({ rejectUnauthorized: false });

    // Axios with cookie jar for session + CSRF
    const jar = new CookieJar();
    const http = wrapper(axios.create({
      jar,
      withCredentials: true,
      timeout: 15000,
      httpsAgent: agent,
      headers: { "Accept": "application/json" }
    }));

    // 1) Hotspot login -> CSRF token
    const login = await http.post(`${base}/api/v2/hotspot/login`, {
      name: OMADA_OPERATOR_USER,
      password: OMADA_OPERATOR_PASS
    }, { headers: { "Content-Type": "application/json" } });

    if (!login.data || login.data.errorCode !== 0) {
      res.status(502).json({ ok: false, error: "Hotspot login failed", detail: login.data });
      return;
    }

    const csrf = login.data.result?.token;
    if (!csrf) {
      res.status(502).json({ ok: false, error: "No CSRF token" });
      return;
    }

    // 2) Authorize client (time is microseconds)
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

    const auth = await http.post(`${base}/api/v2/hotspot/extPortal/auth`, payload, {
      headers: {
        "Content-Type": "application/json",
        "Csrf-Token": csrf
      }
    });

    if (!auth.data || auth.data.errorCode !== 0) {
      res.status(502).json({ ok: false, error: "Authorization failed", detail: auth.data });
      return;
    }

    res.json({ ok: true, redirectUrl: redirectUrl || "http://neverssl.com" });
  } catch (err) {
    console.error("authorize error:", err?.response?.data || err.message || err);
    res.status(500).json({
      ok: false,
      error: err.message || "Internal error",
      detail: err?.response?.data
    });
  }
};
