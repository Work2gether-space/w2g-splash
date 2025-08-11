// api/authorize.js
const axios = require("axios").default;
const https = require("https");

async function tryGet(http, url) {
  try {
    const r = await http.get(url, { headers: { Accept: "application/json" } });
    return { ok: true, data: r.data };
  } catch (err) {
    return { ok: false, err };
  }
}

/**
 * Discover the correct API root for this controller.
 * - software controller:  <base>/api/info
 * - OC200/OC300:          <base>/omadac/api/info
 *
 * Returns { apiRoot, mode } where apiRoot ends at ".../api".
 */
async function discoverApiRoot(http, base) {
  const b = base.replace(/\/$/, "");

  // Try software-controller style first
  const a = await tryGet(http, `${b}/api/info`);
  if (a.ok && a.data?.result) {
    return { apiRoot: `${b}/api`, mode: "root" };
  }

  // Try OC200/OC300 style
  const o = await tryGet(http, `${b}/omadac/api/info`);
  if (o.ok && o.data?.result) {
    return { apiRoot: `${b}/omadac/api`, mode: "omadac" };
  }

  // Default to OC200 style if neither responded (most likely for you)
  return { apiRoot: `${b}/omadac/api`, mode: "fallback-omadac" };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Use POST" });
    return;
  }

  const {
    OMADA_BASE,                 // e.g. https://98.114.198.237:9444
    OMADA_OPERATOR_USER,        // your operator username
    OMADA_OPERATOR_PASS,        // your operator password
    SESSION_MINUTES = "240",
  } = process.env;

  if (!OMADA_BASE || !OMADA_OPERATOR_USER || !OMADA_OPERATOR_PASS) {
    console.error("authorize: missing envs", {
      hasBase: !!OMADA_BASE, hasUser: !!OMADA_OPERATOR_USER, hasPass: !!OMADA_OPERATOR_PASS
    });
    res.status(500).json({ ok: false, error: "Missing env vars" });
    return;
  }

  const { clientMac, apMac, ssidName, radioId, site, redirectUrl } = req.body || {};
  if (!clientMac) {
    res.status(400).json({ ok: false, error: "Missing clientMac" });
    return;
  }

  try {
    // Allow self-signed cert on OC200
    const agent = new https.Agent({ rejectUnauthorized: false });
    const http = axios.create({
      timeout: 12000,
      httpsAgent: agent,
      validateStatus: () => true,
    });

    // 1) Work out the correct API root (…/api)
    const { apiRoot, mode } = await discoverApiRoot(http, OMADA_BASE);
    console.log("authorize: apiRoot", apiRoot, "mode", mode);

    // 2) Login (operator)
    const loginUrl = `${apiRoot}/v2/hotspot/login`;
    console.log("authorize: login ->", loginUrl);

    const login = await http.post(
      loginUrl,
      { name: OMADA_OPERATOR_USER, password: OMADA_OPERATOR_PASS },
      { headers: { "Content-Type": "application/json", Accept: "application/json" } }
    );

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

    // 3) Authorize client
    const timeMicros = String(BigInt(SESSION_MINUTES) * 60n * 1_000_000n);
    const payload = {
      clientMac,
      apMac,
      ssidName,
      radioId: radioId ? Number(radioId) : 1,
      site: site || "Default",
      time: timeMicros,
      authType: 4
    };

    const authUrl = `${apiRoot}/v2/hotspot/extPortal/auth`;
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
