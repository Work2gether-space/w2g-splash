// api/authorize.js  (Vercel Serverless Function - CommonJS)
const axios = require("axios").default;
const tough = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");
const https = require("https");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Use POST" });
    return;
  }

  try {
    const {
      OMADA_BASE,           // e.g. https://98.114.198.237:9443
      OMADA_CONTROLLER_ID,  // usually "omadac" on OC200
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

    const base = `${OMADA_BASE.replace(/\/$/, "")}/${OMADA_CONTROLLER_ID}`;
    const agent = new https.Agent({ rejectUnauthorized: false }); // accept OC200 self-signed cert
    const jar = new tough.CookieJar();
    const http = wrapper(axios.create({ jar, withCredentials: true, timeout: 10000, httpsAgent: agent }));

    // 1) Hotspot login -> CSRF token
    const login = await http.post(`${base}/api/v2/hotspot/login`, {
      name: OMADA_OPERATOR_USER,
      password: OMADA_OPERATOR_PASS
    }, { headers: { "Content-Type": "application/json", "Accept": "application/json" } });

    if (!login.data || login.data.errorCode !== 0) {
      res.status(502).json({ ok: false, error: "Hotspot login failed", detail: login.data });
      return;
    }
    const csrf = login.data.result?.token;
    if (!csrf) { res.status(502).json({ ok: false, error: "No CSRF token" }); return; }

    // 2) Authorize client (time is microseconds)
    const timeMicros = String(BigInt(SESSION_MINUTES) * 60n * 1000000n);
    const payload = {
      clientMac, apMac, ssidName,
      radioId: radioId ? Number(radioId) : 1,
      site, time: timeMicros, authType: 4
    };

    const auth = await http.post(`${base}/api/v2/hotspot/extPortal/auth`, payload, {
      headers: { "Content-Type": "application/json", "Accept": "application/json", "Csrf-Token": csrf }
    });

    if (!auth.data || auth.data.errorCode !== 0) {
      res.status(502).json({ ok: false, error: "Authorization failed", detail: auth.data });
      return;
    }

    res.json({ ok: true, redirectUrl: redirectUrl || "https://neverssl.com" });
  } catch (err) {
    console.error("authorize error:", err?.response?.data || err.message || err);
    res.status(500).json({ ok: false, error: err.message || "Internal error", detail: err?.response?.data });
  }
};
