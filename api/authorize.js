// api/authorize.js
const axios = require("axios").default;
const https = require("https");

/** Try GET and return { ok, data, err } */
async function tryGet(http, url) {
  try {
    const r = await http.get(url, { headers: { Accept: "application/json" } });
    return { ok: true, data: r.data };
  } catch (err) {
    return { ok: false, err };
  }
}

/** Discover controllerId + correct base: root (/api/info) or /omadac (/omadac/api/info) */
async function discoverController(http, base) {
  const b = base.replace(/\/$/, "");

  // A) root
  const a = await tryGet(http, `${b}/api/info`);
  if (a.ok && a.data?.result?.controllerId) {
    return { controllerId: a.data.result.controllerId, usedBase: b, mode: "root" };
  }

  // B) /omadac
  const o = await tryGet(http, `${b}/omadac/api/info`);
  if (o.ok && o.data?.result?.controllerId) {
    return { controllerId: o.data.result.controllerId, usedBase: `${b}/omadac`, mode: "omadac" };
  }

  return { controllerId: null, usedBase: `${b}/omadac`, mode: "unknown" };
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
    console.error("authorize: missing envs", { hasBase: !!OMADA_BASE, hasUser: !!OMADA_OPERATOR_USER, hasPass: !!OMADA_OPERATOR_PASS });
    res.status(500).json({ ok: false, error: "Missing env vars" });
    return;
  }

  const { clientMac, apMac, ssidName, radioId, site, redirectUrl } = req.body || {};
  if (!clientMac) {
    res.status(400).json({ ok: false, error: "Missing clientMac" });
    return;
  }

  try {
    // Self-signed cert ok
    const agent = new https.Agent({ rejectUnauthorized: false });

    // Single axios instance we’ll reuse
    const http = axios.create({
      timeout: 12000,
      httpsAgent: agent,
      validateStatus: () => true, // we'll handle error codes ourselves
    });

    // 1) Discover controller base + id
    const discovery = await discoverController(http, OMADA_BASE);
    console.log("authorize: discovery", discovery);

    // Some firmwares don’t expose controllerId, but /omadac still works with a fixed segment
    const controllerId = discovery.controllerId || "omadac";
    const controllerBase = `${discovery.usedBase.replace(/\/$/, "")}/${controllerId}`;
    const siteId = site || "Default";
    console.log("authorize: controllerBase", controllerBase, "siteId", siteId);

    // 2) Operator login → get CSRF token + cookies
    const loginUrl = `${controllerBase}/api/v2/hotspot/login`;
    console.log("authorize: login ->", loginUrl);

    const login = await http.post(
      loginUrl,
      { name: OMADA_OPERATOR_USER, password: OMADA_OPERATOR_PASS },
      { headers: { "Content-Type": "application/json", Accept: "application/json" } }
    );

    // Must be HTTP 200 and errorCode 0
    if (login.status !== 200 || !login.data || login.data.errorCode !== 0) {
      console.error("authorize: login failed", { status: login.status, data: login.data });
      res.status(502).json({ ok: false, error: "Hotspot login failed", detail: login.data || login.status });
      return;
    }

    const csrf = login.data?.result?.token;
    const setCookie = login.headers["set-cookie"] || [];
    const cookieHeader = setCookie.map(c => c.split(";")[0]).join("; ");
    if (!csrf || !cookieHeader) {
      console.error("authorize: missing csrf/cookie", { csrf: !!csrf, cookieHeader });
      res.status(502).json({ ok: false, error: "Missing CSRF or session cookie from login" });
      return;
    }
    console.log("authorize: got csrf + cookies");

    // 3) Authorize client (duration in microseconds)
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
        "Cookie": cookieHeader,
      },
    });

    if (auth.status !== 200 || !auth.data || auth.data.errorCode !== 0) {
      console.error("authorize: auth failed", { status: auth.status, data: auth.data });
      res.status(502).json({ ok: false, error: "Authorization failed", detail: auth.data || auth.status });
      return;
    }

    console.log("authorize: success for", clientMac);
    res.json({ ok: true, redirectUrl: redirectUrl || "http://neverssl.com" });
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("authorize: ERROR", detail);
    res.status(500).json({ ok: false, error: "Internal error", detail });
  }
};
