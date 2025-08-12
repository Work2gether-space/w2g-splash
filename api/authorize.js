console.log("DEBUG: authorize.js build version 2025-08-11a");

// /api/authorize.js  — drop-in handler for Omada captive-portal authorization

// Optional env overrides
const CONTROLLER_BASE = process.env.OMADA_BASE || 'https://192.168.0.2';
const API_PREFIX = process.env.OMADA_PREFIX || '/fc2b25d44a950a6357313da0afb4c14a';
const OPERATOR_USER = process.env.OMADA_USER || 'w2g_operator';
const OPERATOR_PASS = process.env.OMADA_PASS || 'W2g!2025Net$Auth';
const ALLOW_INSECURE_TLS = `${process.env.ALLOW_INSECURE_TLS || ''}`.toLowerCase() === 'true';

const LOGIN_URL = `${CONTROLLER_BASE}${API_PREFIX}/api/v2/hotspot/login`;
const AUTH_URL  = `${CONTROLLER_BASE}${API_PREFIX}/api/v2/hotspot/extPortal/auth`;

// Best effort support for self-signed controller during LAN testing
if (ALLOW_INSECURE_TLS) {
  // Apply only within this process. Use with care.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// Simple timeout wrapper for fetch
function withTimeout(ms, controller) {
  return setTimeout(() => controller.abort(), ms);
}

// Safely read JSON body from a Next.js/Express/Lambda style request
async function readBody(req) {
  try {
    if (req.body && typeof req.body === 'object') return req.body;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8') || '{}';
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// Extract TPOMADA_SESSIONID from Set-Cookie headers
function extractSessionCookie(headers) {
  // Node 18+ undici exposes getSetCookie; fallback to raw()
  const setCookies = headers.getSetCookie ? headers.getSetCookie()
                   : (headers.raw && headers.raw()['set-cookie']) || [];
  for (const sc of setCookies) {
    const m = /TPOMADA_SESSIONID=([^;]+)/i.exec(sc);
    if (m) return m[1];
  }
  // single header fallback
  const one = headers.get && headers.get('set-cookie');
  if (one) {
    const m = /TPOMADA_SESSIONID=([^;]+)/i.exec(one);
    if (m) return m[1];
  }
  return null;
}

// Extract Csrf-Token header or look in body just in case
function extractCsrfToken(headers, body) {
  const h = headers.get && (headers.get('Csrf-Token') || headers.get('csrf-token') || headers.get('X-Csrf-Token'));
  if (h) return h;
  if (body && body.result && body.result['Csrf-Token']) return body.result['Csrf-Token'];
  if (body && body['Csrf-Token']) return body['Csrf-Token'];
  return null;
}

// Normalize input from captive portal front end
function gatherAuthParams(reqBody, reqQuery) {
  // Allow either direct POST JSON or query params
  const src = { ...reqQuery, ...reqBody };
  // Required by Omada extPortal/auth
  return {
    clientMac: src.clientMac,
    apMac: src.apMac,
    ssidName: src.ssidName,
    radioId: src.radioId,
    site: src.site,
    time: Number(src.time) || 86400000,
    authType: Number(src.authType) || 4, // 4 = radius-like external portal auth
  };
}

// Main handler
async function handler(req, res) {
  try {
    if (req.method !== 'POST' && req.method !== 'GET') {
      res.status(405).json({ ok: false, error: 'Method not allowed' });
      return;
    }

    const body = await readBody(req);
    const params = gatherAuthParams(body, req.query || {});

    // Quick param check
    const missing = Object.entries(params).filter(([_, v]) => v === undefined || v === null || v === '');
    if (missing.length) {
      res.status(400).json({ ok: false, error: 'Missing parameters', missing: missing.map(([k]) => k) });
      return;
    }

    // Step 1: operator login
    const loginCtrl = new AbortController();
    const loginTimer = withTimeout(8000, loginCtrl);
    const loginResp = await fetch(LOGIN_URL, {
      method: 'POST',
      signal: loginCtrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      // Omada expects { username, password }
      body: JSON.stringify({ username: OPERATOR_USER, password: OPERATOR_PASS }),
    }).catch(err => { throw new Error(`Login request failed: ${err.message}`); });
    clearTimeout(loginTimer);

    const loginJson = await loginResp.json().catch(() => ({}));
    if (!loginResp.ok) {
      res.status(502).json({ ok: false, stage: 'login', status: loginResp.status, body: loginJson });
      return;
    }

    const sessionId = extractSessionCookie(loginResp.headers);
    const csrfToken = extractCsrfToken(loginResp.headers, loginJson);

    if (!sessionId) {
      res.status(502).json({ ok: false, stage: 'login', error: 'Missing TPOMADA_SESSIONID cookie from controller' });
      return;
    }
    if (!csrfToken) {
      res.status(502).json({ ok: false, stage: 'login', error: 'Missing Csrf-Token from controller' });
      return;
    }

    // Step 2: extPortal/auth with captured cookie and csrf
    const cookieHeader = `TPOMADA_SESSIONID=${sessionId}`;
    const authCtrl = new AbortController();
    const authTimer = withTimeout(8000, authCtrl);

    const authResp = await fetch(AUTH_URL, {
      method: 'POST',
      signal: authCtrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Csrf-Token': csrfToken,
        'Cookie': cookieHeader,
      },
      body: JSON.stringify(params),
    }).catch(err => { throw new Error(`Auth request failed: ${err.message}`); });
    clearTimeout(authTimer);

    const authJson = await authResp.json().catch(() => ({}));

    // Omada returns { errorCode: 0 } for success
    const success = authResp.ok && authJson && Number(authJson.errorCode) === 0;

    // Respond to captive portal
    if (success) {
      res.status(200).json({
        ok: true,
        allow: true,
        result: authJson,
      });
    } else {
      res.status(401).json({
        ok: false,
        allow: false,
        result: authJson,
        status: authResp.status,
      });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}

// Export for different runtimes
module.exports = handler;
module.exports.default = handler;
