// api/omada_probe.js  Vercel Node runtime, ESM style
// Build: 2025-09-04-3.5e-cloudflared
// Purpose: run the hotspot operator login flow from Vercel and report controller behavior.
// Change: OMADA_BASE now defaults to the Cloudflared tunnel host if the env var is not set.

export default async function handler(req, res) {
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const log = (...a) => console.log(`[omada_probe][${rid}]`, ...a);
  const err = (...a) => console.error(`[omada_probe][${rid}]`, ...a);

  // ---------- env ----------
  const OMADA_BASE = String(process.env.OMADA_BASE || "https://omada-direct.work2gether.space").replace(/\/+$/, "");
  const OMADA_CONTROLLER_ID = process.env.OMADA_CONTROLLER_ID || "fc2b25d44a950a6357313da0afb4c14a";
  const OMADA_OPERATOR_USER = process.env.OMADA_OPERATOR_USER;
  const OMADA_OPERATOR_PASS = process.env.OMADA_OPERATOR_PASS;

  if (!OMADA_OPERATOR_USER || !OMADA_OPERATOR_PASS) {
    return res.status(500).json({
      ok: false,
      error: "Missing required Omada operator credentials",
      present: {
        OMADA_BASE: !!OMADA_BASE,
        OMADA_CONTROLLER_ID: !!OMADA_CONTROLLER_ID,
        OMADA_OPERATOR_USER: !!OMADA_OPERATOR_USER,
        OMADA_OPERATOR_PASS: !!OMADA_OPERATOR_PASS,
      },
    });
  }

  const base = OMADA_BASE;
  const CTRL = OMADA_CONTROLLER_ID;
  const URLS = {
    portal: `${base}/${CTRL}/portal`,
    hotspotLoginPage: `${base}/${CTRL}/hotspot/login`,
    loginStd: `${base}/${CTRL}/api/v2/hotspot/login`,
    loginAlt: `${base}/${CTRL}/api/v2/hotspot/extPortal/login`,
    statusWith: (t) => `${base}/${CTRL}/api/v2/hotspot/loginStatus?token=${encodeURIComponent(t)}&_=${Date.now()}`,
    statusNoToken: `${base}/${CTRL}/api/v2/hotspot/loginStatus?_=${Date.now()}`,
  };

  const axios = (await import("axios")).default;
  const https = await import("https");

  // axios client factory with per request referer
  const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false, maxSockets: 4 });
  const makeClient = (uaTag, referer) =>
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
        Referer: referer || `${base}/${CTRL}/portal`,
      },
    });

  // cookie helpers
  const parseSetCookie = (h) => {
    const arr = Array.isArray(h) ? h : (h ? [h] : []);
    return arr.map((s) => String(s).split(";")[0].trim()).filter(Boolean);
  };
  const mergeCookieStrings = (a, b) => {
    const map = new Map();
    [...a, ...b].forEach((kv) => {
      const [n, ...rest] = kv.split("=");
      map.set(n.trim(), `${n.trim()}=${rest.join("=")}`);
    });
    return [...map.values()];
  };
  const cookieHeaderValue = (cookies) => (cookies.length ? cookies.join("; ") : "");

  const hkeys = (h = {}) => Object.keys(h || {}).map((k) => k.toLowerCase()).sort();
  const bodySample = (data) => {
    try {
      const s = typeof data === "string" ? data : JSON.stringify(data);
      return s.length > 400 ? s.slice(0, 400) + "…" : s;
    } catch {
      return "<unserializable>";
    }
  };
  const findTokenIn = (resp) => {
    const data = resp?.data;
    const bodyToken = data?.result?.token || data?.token || null;
    const hdr = Object.fromEntries(Object.entries(resp?.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const hdrToken = hdr["csrf-token"] || hdr["x-csrf-token"] || null;
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
    tokenPresent: false,
  };

  try {
    let cookies = [];

    // STEP A: warm portal
    {
      const c = makeClient("warm-portal", URLS.portal);
      const r = await c.get(URLS.portal);
      const set = parseSetCookie(r.headers["set-cookie"]);
      cookies = mergeCookieStrings(cookies, set);
      out.steps.push({
        step: "warm_portal",
        url: URLS.portal,
        status: r.status,
        headerKeys: hkeys(r.headers),
        setCookieCount: set.length,
      });
    }

    // STEP B: warm hotspot login page
    {
      const c = makeClient("warm-hotspot", URLS.hotspotLoginPage);
      const r = await c.get(URLS.hotspotLoginPage);
      const set = parseSetCookie(r.headers["set-cookie"]);
      cookies = mergeCookieStrings(cookies, set);
      out.steps.push({
        step: "warm_hotspot_page",
        url: URLS.hotspotLoginPage,
        status: r.status,
        headerKeys: hkeys(r.headers),
        setCookieCount: set.length,
      });
    }

    // STEP C: operator login standard
    let loginResp = null;
    let tokenPieces = { bodyToken: null, hdrToken: null, cookieToken: null };
    {
      const c = makeClient("login-std", URLS.hotspotLoginPage);
      const r = await c.post(
        URLS.loginStd,
        { name: OMADA_OPERATOR_USER, password: OMADA_OPERATOR_PASS },
        {
          headers: {
            "Content-Type": "application/json",
            Cookie: cookieHeaderValue(cookies),
            "X-Requested-With": "XMLHttpRequest",
          },
        }
      );
      const set = parseSetCookie(r.headers["set-cookie"]);
      cookies = mergeCookieStrings(cookies, set);
      tokenPieces = findTokenIn(r);
      loginResp = r;
      out.steps.push({
        step: "login_std",
        url: URLS.loginStd,
        status: r.status,
        headerKeys: hkeys(r.headers),
        setCookieCount: set.length,
        token: tokenPieces,
        bodySample: bodySample(r.data),
      });
    }

    // STEP D: try alt login if no token
    if (!(tokenPieces.bodyToken || tokenPieces.hdrToken || tokenPieces.cookieToken)) {
      const c = makeClient("login-alt", URLS.hotspotLoginPage);
      const r = await c.post(
        URLS.loginAlt,
        { name: OMADA_OPERATOR_USER, password: OMADA_OPERATOR_PASS },
        {
          headers: {
            "Content-Type": "application/json",
            Cookie: cookieHeaderValue(cookies),
            "X-Requested-With": "XMLHttpRequest",
          },
        }
      );
      const set = parseSetCookie(r.headers["set-cookie"]);
      cookies = mergeCookieStrings(cookies, set);
      tokenPieces = findTokenIn(r);
      loginResp = r;
      out.steps.push({
        step: "login_alt",
        url: URLS.loginAlt,
        status: r.status,
        headerKeys: hkeys(r.headers),
        setCookieCount: set.length,
        token: tokenPieces,
        bodySample: bodySample(r.data),
      });
    }

    const token = tokenPieces.bodyToken || tokenPieces.hdrToken || tokenPieces.cookieToken || null;

    // STEP E: status probes
    const statusAttempts = [];
    const statusHeaders = (csrfName) => ({
      Cookie: cookieHeaderValue(cookies),
      "X-Requested-With": "XMLHttpRequest",
      ...(token ? { [csrfName]: token } : {}),
    });

    // try with token param and both CSRF header names
    if (token) {
      for (const name of ["Csrf-Token", "X-Csrf-Token"]) {
        const c = makeClient(`status-with-${name}`, URLS.hotspotLoginPage);
        const r = await c.get(URLS.statusWith(token), { headers: statusHeaders(name) });
        statusAttempts.push({
          variant: `with_token_${name}`,
          url: URLS.statusWith("<redacted>"),
          status: r.status,
          headerKeys: hkeys(r.headers),
          bodySample: bodySample(r.data),
        });
      }
    }

    // try without token param using cookies only
    {
      const c = makeClient("status-no-token", URLS.hotspotLoginPage);
      const r = await c.get(URLS.statusNoToken, { headers: statusHeaders("Csrf-Token") });
      statusAttempts.push({
        variant: "no_token_cookie_csrf",
        url: URLS.statusNoToken,
        status: r.status,
        headerKeys: hkeys(r.headers),
        bodySample: bodySample(r.data),
      });
    }
    {
      const c = makeClient("status-no-token-x", URLS.hotspotLoginPage);
      const r = await c.get(URLS.statusNoToken, { headers: statusHeaders("X-Csrf-Token") });
      statusAttempts.push({
        variant: "no_token_cookie_xcsrf",
        url: URLS.statusNoToken,
        status: r.status,
        headerKeys: hkeys(r.headers),
        bodySample: bodySample(r.data),
      });
    }

    out.steps.push({
      step: "login_status_matrix",
      attempts: statusAttempts,
    });

    out.ok = Boolean(token);
    out.tokenPresent = out.ok;

    return res.status(200).json(out);
  } catch (e) {
    err("probe error:", e?.message || e);
    return res.status(502).json({
      ok: false,
      error: String(e?.message || e),
      base,
      controllerId: CTRL,
    });
  }
}
