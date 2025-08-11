console.log("DEBUG: authorize.js build version 2025-08-11a");


// api/authorize.js
// Auto-detect controller path: tries /omadac, /omada, and root.
// No cookie-jar; we forward Set-Cookie + Csrf-Token manually.

const axios = require("axios").default;
const https = require("https");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Use POST" });
    return;
  }

  try {
    const {
      OMADA_BASE,               // e.g. https://98.114.198.237:9443  (PORTAL port!)
      OMADA_OPERATOR_USER,
      OMADA_OPERATOR_PASS,
      SESSION_MINUTES = "240",
    } = process.env;

    if (!OMADA_BASE || !OMADA_OPERATOR_USER || !OMADA_OPERATOR_PASS) {
      res.status(500).json({ ok: false, error: "Missing env vars" });
      return;
    }

    const {
      clientMac, apMac, ssidName, radioId, site, redirectUrl
    } = req.body || {};
    if (!clientMac || !site) {
      res.status(400).json({ ok: false, error: "Missing clientMac or site" });
      return;
    }

    const agent = new https.Agent({ rejectUnauthorized: false });
    const http = axios.create({
      timeout: 15000,
      httpsAgent: agent,
      validateStatus: () => true,
      headers: { "Accept": "application/json", "Content-Type": "application/json" }
    });

    // Candidate controller path prefixes to try
    const candidates = ["omadac", "omada", ""];

    let workingBase = null;
    let loginData = null;
    let cookieHeader = "";
    let csrf = "";

    // Try each candidate until login succeeds (errorCode === 0)
    for (const c of candidates) {
      const base = `${OMADA_BASE.replace(/\/$/, "")}${c ? "/" + c : ""}`;
      const loginUrl = `${base}/api/v2/hotspot/login`;

      const resp = await http.post(loginUrl, {
        name: OMADA_OPERATOR_USER,
        password: OMADA_OPERATOR_PASS
      });

      // Error codes we specifically see when the path is wrong:
      // -7513 => controller id not exist
      // -1600 => unsupported request path
      if (resp?.data?.errorCode === 0) {
        // success
        workingBase = base;
        loginData = resp.data;
        const setCookie = resp.headers?.["set-cookie"] || [];
        cookieHeader = Array.isArray(setCookie)
          ? setCookie.map(s => s.split(";")[0]).join("; ")
          : "";
        csrf = resp.data?.result?.token || "";
        break;
      } else {
        // Try next candidate
        continue;
      }
    }

    if (!workingBase) {
      return res.status(502).json({
        ok: false,
        where: "login",
        error: "Hotspot login failed for all controller paths (/omadac, /omada, /).",
      });
    }

    if (!csrf || !cookieHeader) {
      return res.status(502).json({
        ok: false,
        where: "login",
        error: "Missing csrf or cookie after successful login",
        baseTried: workingBase
      });
    }

    // Build authorize payload – Omada expects microseconds
    const timeMicros = String(BigInt(SESSION_MINUTES) * 60n * 1000000n);
    const payload = {
      clientMac, apMac, ssidName,
      radioId: radioId ? Number(radioId) : 1,
      site,
      time: timeMicros,
      authType: 4
    };

    const authUrl = `${workingBase}/api/v2/hotspot/extPortal/auth`;
    const auth = await http.post(authUrl, payload, {
      headers: { "Csrf-Token": csrf, "Cookie": cookieHeader }
    });

    if (!auth.data || auth.data.errorCode !== 0) {
      return res.status(502).json({
        ok: false,
        where: "authorize",
        error: "Authorization failed",
        detail: auth.data || null,
        baseUsed: workingBase,
        status: auth.status
      });
    }

    res.json({
      ok: true,
      baseUsed: workingBase,
      redirectUrl: redirectUrl || "http://neverssl.com"
    });

  } catch (err) {
    console.error("authorize fatal:", err?.response?.data || err.message || err);
    res.status(500).json({
      ok: false,
      error: err.message || "Internal error",
      detail: err?.response?.data || null
    });
  }
};
