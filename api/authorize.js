// api/authorize.js
// Build: 2025-09-04-3.5e-cloudflared
// Purpose: External Portal allow flow for W2G_Basic, using Cloudflared tunnel.
// Change: Default OMADA_BASE now points at the tunnel host https://omada-direct.work2gether.space

export default async function handler(req, res) {
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const log = (...a) => console.log(`[authorize][${rid}]`, ...a);
  const err = (...a) => console.error(`[authorize][${rid}]`, ...a);

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Use POST" });
    return;
  }

  // ---------- env ----------
  const OMADA_BASE = String(process.env.OMADA_BASE || "https://omada-direct.work2gether.space").replace(/\/+$/, "");
  const CTRL = process.env.OMADA_CONTROLLER_ID || "fc2b25d44a950a6357313da0afb4c14a";
  const OP_USER = process.env.OMADA_OPERATOR_USER;
  const OP_PASS = process.env.OMADA_OPERATOR_PASS;

  if (!OMADA_BASE || !CTRL || !OP_USER || !OP_PASS) {
    return res.status(500).json({
      ok: false,
      error: "Missing Omada env vars",
      present: {
        OMADA_BASE: !!OMADA_BASE,
        OMADA_CONTROLLER_ID: !!CTRL,
        OMADA_OPERATOR_USER: !!OP_USER,
        OMADA_OPERATOR_PASS: !!OP_PASS,
      },
    });
  }

  // ---------- small helpers ----------
  const vStr = (v) => (v === undefined || v === null ? "" : String(v).trim());
  const pick = (obj, ...keys) => {
    for (const k of keys) {
      const v = obj?.[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
    return "";
  };

  function macRaw(mac) {
    return String(mac || "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  }
  function macColons(mac) {
    const hex = macRaw(mac);
    if (hex.length !== 12) return vStr(mac);
    return hex.match(/.{1,2}/g).join(":");
  }
  function macHyphens(mac) {
    const hex = macRaw(mac);
    if (hex.length !== 12) return vStr(mac);
    return hex.match(/.{1,2}/g).join("-");
  }

  function parseSetCookie(h) {
    const out = [];
    if (!h) return out;
    const arr = Array.isArray(h) ? h : [h];
    for (const line of arr) {
      const kv = String(line).split(";")[0].trim();
      if (kv.includes("=")) out.push(kv);
    }
    return out;
  }
  function mergeCookies(a, b) {
    const m = new Map();
    for (const c of [...(a || []), ...(b || [])]) {
      const [n, ...r] = String(c).split("=");
      m.set(n.trim(), `${n.trim()}=${r.join("=")}`);
    }
    return [...m.values()];
  }

  async function fWithCookies(url, opts = {}, jar = []) {
    const headers = new Headers(opts.headers || {});
    if (jar.length) headers.set("Cookie", jar.join("; "));
    if (!headers.has("User-Agent")) headers.set("User-Agent", "w2g-authorize/2025-09-04");
    if (!headers.has("Accept")) headers.set("Accept", "application/json,text/html;q=0.9,*/*;q=0.1");
    headers.set("Connection", "close");
    headers.set("Pragma", "no-cache");
    headers.set("Cache-Control", "no-cache");
    if (!headers.has("Accept-Language")) headers.set("Accept-Language", "en-US,en;q=0.9");
    if (!headers.has("Origin")) headers.set("Origin", OMADA_BASE);
    if (!headers.has("Referer")) headers.set("Referer", `${OMADA_BASE}/${CTRL}/portal`);

    const resp = await fetch(url, {
      method: opts.method || "GET",
      headers,
      body: opts.body,
      redirect: "manual",
    });

    const set = parseSetCookie(resp.headers.get("set-cookie"));
    return { resp, jar: mergeCookies(jar, set) };
  }

  async function warmHotspot(jar = []) {
    const { resp, jar: j } = await fWithCookies(
      `${OMADA_BASE}/${CTRL}/hotspot/login?_=${Date.now()}`,
      { method: "GET", headers: { Referer: `${OMADA_BASE}/${CTRL}/hotspot/login` } },
      jar
    );
    await resp.text().catch(() => {});
    return { status: resp.status, jar: j };
  }

  async function operatorLogin(jar = []) {
    const url = `${OMADA_BASE}/${CTRL}/api/v2/hotspot/login?_=${Date.now()}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${OMADA_BASE}/${CTRL}/hotspot/login`,
    };
    const body = JSON.stringify({ name: OP_USER, password: OP_PASS });
    const { resp, jar: j2 } = await fWithCookies(url, { method: "POST", headers, body }, jar);
    const text = await resp.text().catch(() => "");
    let bodyToken = null;
    try { const j = JSON.parse(text); bodyToken = j?.result?.token || j?.token || null; } catch {}
    const hdrToken = resp.headers.get("csrf-token") || resp.headers.get("x-csrf-token") || null;
    const token = bodyToken || hdrToken || null;
    return { status: resp.status, token, raw: text, jar: j2 };
  }

  // ---------- input ----------
  const body = typeof req.body === "object" ? req.body : {};
  const ssidName = pick(body, "ssidName", "ssid");
  const isExternalPortal = ssidName === "W2G_Basic";

  if (!isExternalPortal) {
    return res.status(200).json({
      ok: false,
      error: "This build only patches External-Portal path for W2G_Basic. SSID is not W2G_Basic.",
      ssidName,
    });
  }

  const cmIn = pick(body, "clientMac");
  const amIn = pick(body, "apMac", "gatewayMac");
  const site = pick(body, "site", "siteId");
  const radioId = pick(body, "radioId", "radio") || "1";
  const redirectUrl = (() => {
    const r = pick(body, "redirectUrl") || "http://neverssl.com";
    try {
      const dec = decodeURIComponent(r);
      if (/captiveportal|connecttest|generate_204|msftconnecttest|wifiportal/i.test(dec)) return "http://neverssl.com";
      return dec;
    } catch { return "http://neverssl.com"; }
  })();

  if (!cmIn) {
    return res.status(400).json({ ok: false, error: "Missing clientMac" });
  }

  // Build variants
  const macVariants = [
    { name: "colons",  clientMac: macColons(cmIn), apMac: amIn ? macColons(amIn) : "" },
    { name: "hyphens", clientMac: macHyphens(cmIn), apMac: amIn ? macHyphens(amIn) : "" },
    { name: "rawhex",  clientMac: macRaw(cmIn),     apMac: amIn ? macRaw(amIn)     : "" },
  ];
  const paths = [
    { path: "/api/v2/hotspot/extPortal/auth", referer: "/hotspot/login" },
    { path: "/api/v2/portal/extPortal/auth",  referer: "/portal"        },
    { path: "/api/v2/extPortal/auth",         referer: "/portal"        },
  ];
  const csrfNames = ["Csrf-Token", "X-Csrf-Token"];
  const bodies = [
    { kind: "json_full", ctype: "application/json" },
    { kind: "form_full", ctype: "application/x-www-form-urlencoded" },
    { kind: "get_fallback", ctype: null },
  ];

  const buildBodyObj = ({ clientMac, apMac }) => {
    const o = { clientMac, authResult: 1, ssidName, radioId, redirectUrl };
    if (site) o.site = site;
    if (apMac) o.apMac = apMac;
    return o;
  };

  // ---------- main flow ----------
  try {
    // 0) warm
    let jar = [];
    const w = await warmHotspot(jar); jar = w.jar;

    // 1) operator login
    const op = await operatorLogin(jar); jar = op.jar;
    const token = op.token || null;

    const attempts = [];
    let chosen = null;

    // 2) matrix of attempts
    for (const p of paths) {
      for (const m of macVariants) {
        for (const bdef of bodies) {
          if (bdef.kind === "get_fallback") {
            const q = new URLSearchParams();
            const b = buildBodyObj(m);
            Object.entries(b).forEach(([k, v]) => q.set(k, String(v)));
            const url = `${OMADA_BASE}/${CTRL}${p.path}?${q.toString()}&_=${Date.now()}`;
            const headers = {
              "X-Requested-With": "XMLHttpRequest",
              Referer: `${OMADA_BASE}/${CTRL}${p.referer}`,
            };
            if (token) headers["Csrf-Token"] = token;

            const r = await fWithCookies(url, { method: "GET", headers }, jar);
            const text = await r.resp.text().catch(() => "");
            let data; try { data = JSON.parse(text); } catch { data = { errorCode: -1, msg: "Non-JSON", raw: text }; }
            const rec = {
              path: p.path,
              referer: p.referer,
              macVariant: m.name,
              bodyKind: bdef.kind,
              csrfHeader: "Csrf-Token",
              http: r.resp.status,
              data,
              posted: b,
            };
            attempts.push(rec);
            jar = r.jar;
            if (Number(data?.errorCode) === 0 || r.resp.status === 302) { chosen = rec; break; }
            continue;
          }

          for (const csrfName of csrfNames) {
            const url = `${OMADA_BASE}/${CTRL}${p.path}?_=${Date.now()}`;
            const headers = {
              "Content-Type": bdef.ctype,
              "X-Requested-With": "XMLHttpRequest",
              Referer: `${OMADA_BASE}/${CTRL}${p.referer}`,
            };
            if (token) headers[csrfName] = token;

            let bodyPayload;
            let bodySentPreview;
            if (bdef.kind === "json_full") {
              const obj = buildBodyObj(m);
              bodyPayload = JSON.stringify(obj);
              bodySentPreview = obj;
            } else {
              const form = new URLSearchParams();
              const obj = buildBodyObj(m);
              Object.entries(obj).forEach(([k, v]) => form.set(k, String(v)));
              bodyPayload = form.toString();
              bodySentPreview = Object.fromEntries(new URLSearchParams(bodyPayload).entries());
            }

            const r = await fWithCookies(url, { method: "POST", headers, body: bodyPayload }, jar);
            const text = await r.resp.text().catch(() => "");
            let data; try { data = JSON.parse(text); } catch { data = { errorCode: -1, msg: "Non-JSON", raw: text }; }

            const rec = {
              path: p.path,
              referer: p.referer,
              macVariant: m.name,
              bodyKind: bdef.kind,
              csrfHeader: csrfName,
              http: r.resp.status,
              data,
              posted: bodySentPreview,
            };
            attempts.push(rec);
            jar = r.jar;

            if (Number(data?.errorCode) === 0 || r.resp.status === 302) { chosen = rec; break; }
          }
          if (chosen) break;
        }
        if (chosen) break;
      }
      if (chosen) break;
    }

    if (!chosen) {
      return res.status(200).json({
        ok: false,
        error: "External portal allow did not succeed",
        ssidName,
        attempts,
        omadaBase: OMADA_BASE,
      });
    }

    // 3) optional loginStatus echo
    const statusUrl = `${OMADA_BASE}/${CTRL}/api/v2/hotspot/loginStatus?_=${Date.now()}`;
    const rStatus = await fWithCookies(statusUrl, { method: "GET", headers: { Referer: `${OMADA_BASE}/${CTRL}/hotspot/login` } }, jar);
    const statusText = await rStatus.resp.text().catch(() => "");
    let statusJson = null; try { statusJson = JSON.parse(statusText); } catch {}

    // 4) success
    return res.status(200).json({
      ok: true,
      mode: "external-portal-allow",
      ssidName,
      clientMac: macColons(cmIn),
      apMac: amIn ? macColons(amIn) : null,
      radioId,
      redirectUrl,
      omadaBase: OMADA_BASE,
      omada: {
        operatorLogin: { status: op.status, tokenPresent: !!token },
        chosen,
        loginStatusEcho: { http: rStatus.resp.status, json: statusJson || null },
      },
      message: "External portal allow submitted; client should be released by controller.",
    });
  } catch (e) {
    err("authorize error:", e?.stack || e);
    return res.status(502).json({ ok: false, error: String(e?.message || e) });
  }
}
