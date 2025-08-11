// api/authorize.js  (Vercel Serverless Function - CommonJS, no controller-id env)
const axios = require("axios").default;
const { CookieJar } = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");
const https = require("https");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Use POST" });
    return;
  }

  const {
    OMADA_BASE,            // e.g. https://98.114.198.237:9444  (your mgmt forward)
    OMADA_OPERATOR_USER,   // OC200 web username
    OMADA_OPERATOR_PASS,   // OC200 web password
    SESSION_MINUTES = "240",
  } = process.env;

  if (!OMADA_BASE || !OMADA_OPERATOR_USER || !OMADA_OPERATOR_PASS) {
    res.status(500).json({ ok: false, error: "Missing env vars" });
    return;
  }

  const { clientMac, apMac, ssidName, radioId, site, redirectUrl } = req.body || {};
  if (!clientMac || !site) {
    res.status(400).json({ ok: false, error: "Missing clientMac or site" });
    return;
  }

  // Try common OC200 paths automatically so we don't need a controller-id env
  const norm = (s) => s.replace(/\/+$/,"");
  const base = norm(OMADA_BASE);
  const candidates = [ base, `${base}/omadac`, `${base}/omada` ];

  const agent = new https.Agent({ rejectUnauthorized: false }); // accept self-signed
  const jar = new CookieJar();
  const http = wrapper(axios.create({ jar, withCredentials: true, timeout: 12000, httpsAgent: agent }));

  // 1) Login to hotspot to obtain CSRF + session cookie
  let csrf = null, chosen = null, loginResp = null, lastErr = null;
  for (const root of candidates) {
    try {
      const r = await http.post(`${root}/api/v2/hotspot/login`, {
        name: OMADA_OPERATOR_USER,
        password: OMADA_OPERATOR_PASS
      }, { headers: { "Content-Type": "application/json", "Accept": "application/json" } });

      loginResp = r;
      if (r?.data?.errorCode === 0 && r?.data?.result?.token) {
        csrf = r.data.result.token;
        chosen = root;
        break;
      }
    } catch (e) {
      lastErr = e;
    }
  }

  if (!csrf) {
    const detail = loginResp?.data || lastErr?.response?.data || lastErr?.message || "unknown";
    console.error("Hotspot login failed:", detail);
    res.status(502).json({ ok: false, error: "Hotspot login failed", detail });
    return;
  }

  try {
    // 2) Authorize client (time in microseconds)
    const timeMicros = String(BigInt(SESSION_MINUTES) * 60n * 1000000n);
    const payload = {
      clientMac, apMac, ssidName,
      radioId: radioId ? Number(radioId) : 1,
      site, time: timeMicros, authType: 4
    };

    const auth = await http.post(`${chosen}/api/v2/hotspot/extPortal/auth`, payload, {
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Csrf-Token": csrf
      }
    });

    if (auth?.data?.errorCode !== 0) {
      console.error("Authorization failed:", auth?.data);
      res.status(502).json({ ok: false, error: "Authorization failed", detail: auth?.data });
      return;
    }

    res.json({ ok: true, redirectUrl: redirectUrl || "https://neverssl.com" });
  } catch (e) {
    const detail = e?.response?.data || e?.message || "unknown";
    console.error("Authorize error:", detail);
    res.status(500).json({ ok: false, error: e?.message || "Internal error", detail });
  }
};
