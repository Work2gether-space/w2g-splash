// api/authorize.js  (Vercel Serverless Function - CommonJS)
const axios = require("axios").default;
const tough = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");
const https = require("https");

/**
 * Helper to try an HTTP GET and return { ok, data, error }
 */
async function tryGet(http, url) {
  try {
    const r = await http.get(url, { headers: { Accept: "application/json" } });
    return { ok: true, data: r.data };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/**
 * Discover controllerId and the correct base:
 * 1) Try <OMADA_BASE>/api/info (root pattern)
 * 2) Try <OMADA_BASE>/omadac/api/info (omadac pattern)
 */
async function discoverController(http, base) {
  const b = base.replace(/\/$/, "");

  // pattern A: root
  const a = await tryGet(http, `${b}/api/info`);
  if (a.ok && a.data && a.data.result && a.data.result.controllerId) {
    return {
      controllerId: a.data.result.controllerId,
      usedBase: b,
      infoPath: "root"
    };
  }

  // pattern B: /omadac
  const bTry = await tryGet(http, `${b}/omadac/api/info`);
  if (bTry.ok && bTry.data && bTry.data.result && bTry.data.result.controllerId) {
    return {
      controllerId: bTry.data.result.controllerId,
      usedBase: `${b}/omadac`,
      infoPath: "omadac"
    };
  }

  // fallbacks – if neither returned controllerId, still return best guess
  return {
    controllerId: null,
    usedBase: `${b}/omadac`,
    infoPath: "none"
  };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Use POST" });
    return;
  }

  const {
    OMADA_BASE,
    OMADA_OPERATOR_USER,
    OMADA_OPERATOR_PASS,
    SESSION_MINUTES = "240",
  } = process.env;

  if (!OMADA_BASE || !OMADA_OPERATOR_USER || !OMADA_OPERATOR_PASS) {
    console.error("authorize: missing env vars", { hasBase: !!OMADA_BASE, hasUser: !!OMADA_OPERATOR_USER, hasPass: !!OMADA_OPERATOR_PASS });
    res.status(500).json({ ok: false, error: "Missing env vars" });
    return;
  }

  const { clientMac, apMac, ssidName, radioId, site, redirectUrl } = req.body || {};
  if (!clientMac) {
    res.status(400).json({ ok: false, error: "Missing clientMac" });
    return;
  }

  try {
    const agent = new https.Agent({ rejectUnauthorized: false });
    const jar = new tough.CookieJar();
    const http = wrapper(axios.create({
      jar,
      withCredentials: true,
      timeout: 10000,
      httpsAgent: agent,
    }));

    // Discover controller ID and which base to use
    const discovery = await discoverController(http, OMADA_BASE);
    console.log("authorize: discovery", discovery);

    // If site is not provided by the controller redirect, you can set a default here
    const siteId = site || "Default";

    if (!discovery.controllerId) {
      console.warn("authorize: controllerId not discovered from /api/info; continuing with guessed base");
    }

    const controllerBase = `${discovery.usedBase}/${discovery.controllerId || "omadac"}`.replace(/\/+$/, "");
    console.log("authorize: controllerBase ->", controllerBase);

    // 1) Hotspot operator login -> CSRF token
    const loginUrl = `${controllerBase}/api/v2/hotspot/login`;
    console.log("authorize: login ->", loginUrl);

    const login = await http.post(
      loginUrl,
      { name: OMADA_OPERATOR_USER, password: OMADA_OPERATOR_PASS },
      { headers: { "Content-Type": "application/json", Accept: "application/json" } }
    );

    console.log("authorize: login data", login.data);
    if (!login.data || login.data.errorCode !== 0) {
      return res.status(502).json({ ok: false, error: "Hotspot login failed", detail: login.data });
    }
    const csrf = login.data.result?.token;
    if (!csrf) {
      return res.status(502).json({ ok: false, error: "No CSRF token from hotspot login" });
    }

    // 2) Authorize client (time in microseconds)
    const timeMicros = String(BigInt(SESSION_MINUTES) * 60n * 1_000_000n);
    const payload = {
      clientMac,
      apMac,
      ssidName,
      radioId: radioId ? Number(radioId) : 1,
      site: siteId,
      time: timeMicros,
      authType: 4, // external portal
    };

    const authUrl = `${controllerBase}/api/v2/hotspot/extPortal/auth`;
    console.log("authorize: auth ->", authUrl, payload);

    const auth = await http.post(authUrl, payload, {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Csrf-Token": csrf,
      },
    });

    console.log("authorize: auth data", auth.data);

    if (!auth.data || auth.data.errorCode !== 0) {
      return res.status(502).json({ ok: false, error: "Authorization failed", detail: auth.data });
    }

    res.json({ ok: true, redirectUrl: redirectUrl || "http://neverssl.com" });
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("authorize: ERROR", detail);
    res.status(500).json({ ok: false, error: "Internal error", detail });
  }
};
