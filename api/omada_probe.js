// api/omada_probe.js  — Vercel Node runtime, ESM style
// Purpose: run the exact hotspot login flow FROM Vercel and report what the controller/Cloudflare returns.
// Build: 2025-08-28-probe-1

export default async function handler(req, res) {
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const log = (...a) => console.log(`[omada_probe][${rid}]`, ...a);
  const err = (...a) => console.error(`[omada_probe][${rid}]`, ...a);

  const {
    OMADA_BASE,
    OMADA_CONTROLLER_ID,
    OMADA_OPERATOR_USER,
    OMADA_OPERATOR_PASS,
  } = process.env;

  // quick env sanity
  if (!OMADA_BASE || !OMADA_CONTROLLER_ID || !OMADA_OPERATOR_USER || !OMADA_OPERATOR_PASS) {
    return res.status(500).json({
      ok: false,
      error: "Missing required Omada env vars",
      present: {
        OMADA_BASE: !!OMADA_BASE,
        OMADA_CONTROLLER_ID: !!OMADA_CONTROLLER_ID,
        OMADA_OPERATOR_USER: !!OMADA_OPERATOR_USER,
        OMADA_OPERATOR_PASS: !!OMADA_OPERATOR_PASS,
      },
    });
  }

  // normalize
  const base = String(OMADA_BASE).replace(/\/+$/, "");
  const CTRL = OMADA_CONTROLLER_ID;
  const PORTAL_URL = `${base}/${CTRL}/portal`;
  const HOTSPOT_LOGIN_PAGE = `${base}/${CTRL}/hotspot/login`;
  const LOGIN_STD = `${base}/${CTRL}/api/v2/hotspot/login`;
  const LOGIN_ALT = `${base}/${CTRL}/api/v2/hotspot/extPortal/login`;
  const STATUS_URL = (t) => `${base}/${CTRL}/api/v2/hotspot/loginStatus?token=${encodeURIComponent(t)}`;

  const axios = (await import("axios")).default;
  const https = await import("https");

  // tiny helpers
  const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false, maxSockets: 2 });
  const makeClient = (uaTag) =>
    axios.create({
      timeout: 15000,
      httpsAgent: agent,
      maxRedirects: 0,
      validateStatus: () => true,
      headers: {
        Accept: "application/json,text/html;q=0.9,*/*;q=0.1",
        "User-Agent": `w2g-omada-probe/${uaTag}`,
        Connection: "close",
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        "Accept-Language": "en-US,en;q=0.9",
        Origin: base,
        Referer: PORTAL_URL,
      },
    });

  const hkeys = (h = {}) => Object.keys(h || {}).map((k) => k.toLowerCase()).sort();
  const cookieCount = (resp) => {
    const sc = resp?.headers?.["set-cookie"];
    return Array.isArray(sc) ? sc.length : (sc ? 1 : 0);
  };
  const cookieHeaderValue = (resp) => {
    const sc = resp?.headers?.["set-cookie"];
    if (!Array.isArray(sc)) return "";
    // turn into "k=v; k2=v2"
    return sc.map((c) => String(c).split(";")[0]).join("; ");
  };
  const findTokenIn = (resp) => {
    // body token
    const bodyToken =
      resp?.data?.result?.token ||
      resp?.data?.token ||
      null;

    // header token(s)
    const hdr = Object.fromEntries(
      Object.entries(resp?.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
    );
    const hdrToken = hdr["csrf-token"] || hdr["x-csrf-token"] || null;

    // cookie token-ish
    const sc = resp?.headers?.["set-cookie"] || [];
    const joined = Array.isArray(sc) ? sc.join("; ") : String(sc || "");
    const m =
      joined.match(/csrf[-_]?token=([^;]+)/i) ||
      joined.match(/x[-_]?csrf[-_]?token=([^;]+)/i) ||
      joined.match(/portal[-_]?csrf=([^;]+)/i);
    const cookieToken = m ? m[1] : null;

    return { bodyToken, hdrToken, cookieToken };
  };

  const out = {
    ok: false,
    base,
    controllerId: CTRL,
    steps: [],
  };

  try {
    // STEP A: warm up (portal)
    const cWarmPortal = makeClient("warm-portal");
    const rWarmPortal = await cWarmPortal.get(PORTAL_URL);
    out.steps.push({
      step: "warm_portal",
      url: PORTAL_URL,
      status: rWarmPortal.status,
      headerKeys: hkeys(rWarmPortal.headers),
      setCookieCount: cookieCount(rWarmPortal),
    });

    // STEP B: warm up (hotspot login page)
    const cWarmHotspot = makeClient("warm-hotspot");
    const rWarmHotspot = await cWarmHotspot.get(HOTSPOT_LOGIN_PAGE);
    const warmCookies = cookieHeaderValue(rWarmHotspot);
    out.steps.push({
      step: "warm_hotspot_page",
      url: HOTSPOT_LOGIN_PAGE,
      status: rWarmHotspot.status,
      headerKeys: hkeys(rWarmHotspot.headers),
      setCookieCount: cookieCount(rWarmHotspot),
    });

    // STEP C: POST login (standard)
    const cLoginStd = makeClient("login-std");
    const rLoginStd = await cLoginStd.post(
      LOGIN_STD,
      { name: OMADA_OPERATOR_USER, password: OMADA_OPERATOR_PASS },
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: warmCookies,
          "X-Requested-With": "XMLHttpRequest",
        },
      }
    );
    const tStd = findTokenIn(rLoginStd);
    out.steps.push({
      step: "login_std",
      url: LOGIN_STD,
      status: rLoginStd.status,
      headerKeys: hkeys(rLoginStd.headers),
      setCookieCount: cookieCount(rLoginStd),
      token: tStd,
      bodySampleType: typeof rLoginStd.data,
    });

    // If no token from std, try alt
    let token = tStd.bodyToken || tStd.hdrToken || tStd.cookieToken || null;
    let loginResp = rLoginStd;

    if (!token) {
      const cLoginAlt = makeClient("login-alt");
      const rLoginAlt = await cLoginAlt.post(
        LOGIN_ALT,
        { name: OMADA_OPERATOR_USER, password: OMADA_OPERATOR_PASS },
        {
          headers: {
            "Content-Type": "application/json",
            Cookie: warmCookies,
            "X-Requested-With": "XMLHttpRequest",
          },
        }
      );
      const tAlt = findTokenIn(rLoginAlt);
      out.steps.push({
        step: "login_alt",
        url: LOGIN_ALT,
        status: rLoginAlt.status,
        headerKeys: hkeys(rLoginAlt.headers),
        setCookieCount: cookieCount(rLoginAlt),
        token: tAlt,
        bodySampleType: typeof rLoginAlt.data,
      });
      token = tAlt.bodyToken || tAlt.hdrToken || tAlt.cookieToken || null;
      loginResp = rLoginAlt;
    }

    // STEP D: optional loginStatus check (only if we found a token)
    if (token) {
      const cStatus = makeClient("status");
      const rStatus = await cStatus.get(STATUS_URL(token), {
        headers: {
          Cookie: cookieHeaderValue(loginResp),
          "X-Requested-With": "XMLHttpRequest",
          "Csrf-Token": token,
        },
      });
      out.steps.push({
        step: "login_status",
        url: STATUS_URL("<redacted>"),
        status: rStatus.status,
        headerKeys: hkeys(rStatus.headers),
        setCookieCount: cookieCount(rStatus),
        bodyKeys: rStatus && rStatus.data ? Object.keys(rStatus.data) : null,
        resultEcho: rStatus?.data?.result || null,
      });
      out.ok = true;
      out.tokenPresent = true;
    } else {
      out.ok = false;
      out.tokenPresent = false;
    }

    return res.status(200).json(out);
  } catch (e) {
    err("probe error:", e?.message || e);
    out.ok = false;
    out.error = String(e?.message || e);
    return res.status(502).json(out);
  }
}
