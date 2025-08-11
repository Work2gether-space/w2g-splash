// api/authorize.js  (Vercel Serverless Function - CommonJS)
// No cookie-jar; we manually forward the Set-Cookie from login to authorize.

const axios = require("axios").default;
const https = require("https");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Use POST" });
    return;
  }

  try {
    const {
      OMADA_BASE,               // e.g. https://98.114.198.237:9443  (portal port!)
      OMADA_OPERATOR_USER,      // OC200 user
      OMADA_OPERATOR_PASS,      // OC200 pass
      SESSION_MINUTES = "240",
    } = process.env;

    // On OC200 the controller path is typically /omadac
    const CONTROLLER_ID = "omadac";

    if (!OMADA_BASE || !OMADA_OPERATOR_USER || !OMADA_OPERATOR_PASS) {
      res.status(500).json({ ok: false, error: "Missing env vars" });
      return;
    }

    const {
      clientMac,   // from Omada external portal
      apMac,
      ssidName,
      radioId,
      site,        // site ID from Omada
      redirectUrl,
    } = req.body || {};

    if (!clientMac || !site) {
      res.status(400).json({ ok: false, error: "Missing clientMac or site" });
      return;
    }

    const base = `${OMADA_BASE.replace(/\/$/, "")}/${CONTROLLER_ID}`;
    const agent = new https.Agent({ rejectUnauthorized: false });

    // Helper: axios with safe default
    const http = axios.create({
      timeout: 15000,
      httpsAgent: agent,
      validateStatus: () => true,
      headers: { "Accept": "application/json", "Content-Type": "application/json" }
    });

    // 1) Hotspot login -> CSRF token + Set-Cookie
    const loginUrl = `${base}/api/v2/hotspot/login`;
    const loginBody = { name: OMADA_OPERATOR_USER, password: OMADA_OPERATOR_PASS };

    const login = await http.post(loginUrl, loginBody);

    if (!login.data || login.data.errorCode !== 0) {
      return res.status(502).json({
        ok: false,
        where: "login",
        error: "Hotspot login failed",
        detail: login.data || null,
        status: login.status
      });
    }

    const csrf = login.data.result?.token || "";
    const setCookie = login.headers?.["set-cookie"] || [];
    const cookieHeader = Array.isArray(setCookie)
      ? setCookie.map(c => c.split(";")[0]).join("; ")
      : "";

    if (!csrf || !cookieHeader) {
      return res.status(502).json({
        ok: false,
        where: "login",
        error: "Missing csrf or cookie from login",
        gotCsrf: Boolean(csrf),
        gotCookie: Boolean(cookieHeader)
      });
    }

    // 2) Authorize client
    // Omada expects time in MICROSECONDS
    const timeMicros = String(BigInt(SESSION_MINUTES) * 60n * 1000000n);

    const authUrl = `${base}/api/v2/hotspot/extPortal/auth`;
    const payload = {
      clientMac,
      apMac,
      ssidName,
      radioId: radioId ? Number(radioId) : 1,
      site,
      time: timeMicros,
      authType: 4
    };

    const auth = await http.post(authUrl, payload, {
      headers: { "Csrf-Token": csrf, "Cookie": cookieHeader }
    });

    if (!auth.data || auth.data.errorCode !== 0) {
      return res.status(502).json({
        ok: false,
        where: "authorize",
        error: "Authorization failed",
        detail: auth.data || null,
        status: auth.status
      });
    }

    // Success — send the redirect back to the page script
    res.json({ ok: true, redirectUrl: redirectUrl || "http://neverssl.com" });

  } catch (err) {
    console.error("authorize error:", err?.response?.data || err.message || err);
    res.status(500).json({
      ok: false,
      error: err.message || "Internal error",
      detail: err?.response?.data || null
    });
  }
};
