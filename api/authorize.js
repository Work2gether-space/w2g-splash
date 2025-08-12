console.log("DEBUG: authorize.js build version 2025-08-11a");

console.log("DEBUG: authorize.js build version 2025-08-11b");

// /api/authorize.js  — drop in handler for Omada captive portal authorization

// Optional env overrides
const CONTROLLER_BASE = process.env.OMADA_BASE || 'https://192.168.0.2';
const API_PREFIX = process.env.OMADA_PREFIX || '/fc2b25d44a950a6357313da0afb4c14a';
const OPERATOR_USER = process.env.OMADA_USER || 'w2g_operator';
const OPERATOR_PASS = process.env.OMADA_PASS || 'W2g!2025Net$Auth';
const ALLOW_INSECURE_TLS = `${process.env.ALLOW_INSECURE_TLS || ''}`.toLowerCase() === 'true';

const LOGIN_URL = `${CONTROLLER_BASE}${API_PREFIX}/api/v2/hotspot/login`;
const AUTH_URL  = `${CONTROLLER_BASE}${API_PREFIX}/api/v2/hotspot/extPortal/auth`;

// Best effort support for self signed cert during LAN testing
if (ALLOW_INSECURE_TLS) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// Simple timeout wrapper for fetch
function withTimeout(ms, controller) {
  return setTimeout(() => controller.abort(), ms);
}

// Send JSON on Express or plain Node http
function sendJson(res, code, obj) {
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    res.status(code).json(obj);
  } else {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
  }
}

// Get query params from Express or plain Node http
function getQuery(req) {
  try {
    if (req.query) return req.query;
    const { parse } = require('url');
    return parse(req.url, true).query || {};
  } catch {
    return {};
  }
}

// Safely read JSON body from a Next.js, Express, or plain Node request
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

// Extract TPOMADA_SESSIONID from Set Cookie headers
function extractSessionCookie(headers) {
  const setCookies = headers.getSetCookie ? headers.getSetCookie()
                   : (headers.raw && headers.raw()['set-cookie']) || [];
  for (const sc of setCookies) {
    const m = /TPOMADA_SESSIONID=([^;]+)/i.exec(sc);
    if (m) return m[1];
  }
  const one = headers.get && headers.get('set-cookie');
  if (one) {
    const m = /TPOMADA_SESSIONID=([^;]+)/i.exec(one);
    if (m) return m[1];
  }
  return null;
}

// Extract Csrf Token header or body field
function extractCsrfToken(headers, body) {
  const h = headers.get && (headers.get('Csrf-Token') || headers.get('csrf-token') || headers.get('X-Csrf-Token'));
  if (h) return h;
  if (body && body.result && body.result['Csrf-Token']) return body.result['Csrf-Token'];
  if (body && body['Csrf-Token']) return body['Csrf-Token'];
  return null;
}

// Normalize input from captive portal front end
function gatherAuthParams(reqBody, reqQuery) {
  const src = { ...reqQuery, ...reqBody };
  return {
    clientMac: src.clientMac,
    apMac: src.apMac,
    ssidName: src.ssidName,
    radioId: src.radioId,
    site: src.site,
    time: Number(src.time) || 86400000,
    authType: Number(src.authType) || 4
  };
}

// Main handler
async function handler(req, res) {
  try {
    if (req.method !== 'POST' && req.method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    }

    const body = await readBody(req);
    const params = gatherAuthParams(body, getQuery(req));

    const missing = Object.entries(params).filter(([_, v]) => v === undefined || v === null || v === '');
    if (missing.length) {
      return sendJson(res, 400, { ok: false, error: 'Missing parameters', missing: missing.map(([k]) => k) });
    }

    // Step 1 login
    const loginCtrl = new AbortController();
    const loginTimer = withTimeout(8000, loginCtrl);
    const loginResp = await fetch(LOGIN_URL, {
      method: 'POST',
      signal: loginCtrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ username: OPERATOR_USER, password: OPERATOR_PASS })
    }).catch(err => { throw new Error(`Login request failed: ${err.message}`); });
    clearTimeout(loginTimer);

    const loginJson = await loginResp.json().catch(() => ({}));
    if (!loginResp.ok) {
      return sendJson(res, 502, { ok: false, stage: 'login', status: loginResp.status, body: loginJson });
    }

    const sessionId = extractSessionCookie(loginResp.headers);
    const csrfToken = extractCsrfToken(loginResp.headers, loginJson);

    if (!sessionId) {
      return sendJson(res, 502, { ok: false, stage: 'login', error: 'Missing TPOMADA_SESSIONID cookie from controller' });
    }
    if (!csrfToken) {
      return sendJson(res, 502, { ok: false, stage: 'login', error: 'Missing Csrf-Token from controller' });
    }

    // Step 2 extPortal auth
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
        'Cookie': cookieHeader
      },
      body: JSON.stringify(params)
    }).catch(err => { throw new Error(`Auth request failed: ${err.message}`); });
    clearTimeout(authTimer);

    const authJson = await authResp.json().catch(() => ({}));
    const success = authResp.ok && authJson && Number(authJson.errorCode) === 0;

    if (success) {
      return sendJson(res, 200, { ok: true, allow: true, result: authJson });
    } else {
      return sendJson(res, 401, { ok: false, allow: false, result: authJson, status: authResp.status });
    }
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message || String(err) });
  }
}

// Export for different runtimes
module.exports = handler;
module.exports.default = handler;

