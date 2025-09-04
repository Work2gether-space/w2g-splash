// server.js  minimal HTTP server for local testing
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // ok for LAN testing only

const http = require('http');
const { URL } = require('url');

function safeRequire(p) {
  try { return require(p); } catch { return null; }
}
function asHandler(mod) {
  if (!mod) return null;
  // support: CJS export (fn), CJS {handler}, ESM default export, ESM named export
  if (typeof mod === 'function') return mod;
  if (typeof mod.default === 'function') return mod.default;
  if (typeof mod.handler === 'function') return mod.handler;
  return null;
}

// Load handlers (add any others you want to test locally)
const authorize        = asHandler(safeRequire('./api/authorize'));
const submitEmail      = asHandler(safeRequire('./api/submit_email'));
const omadaProbe       = asHandler(safeRequire('./api/omada_probe'));
const omadaLoginTest   = asHandler(safeRequire('./api/omada_login_test'));
const omadaAuthProbe   = asHandler(safeRequire('./api/omada_auth_probe'));
const omadaExtAuthMin  = asHandler(safeRequire('./api/omada_ext_auth_min'));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const OMADA_BASE = String(process.env.OMADA_BASE || 'https://omada-direct.work2gether.space').replace(/\/+$/, '');
const CTRL = process.env.OMADA_CONTROLLER_ID || 'fc2b25d44a950a6357313da0afb4c14a';

function setCors(res) {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Csrf-Token, X-Csrf-Token, X-Debug-Probe');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  } catch {}
}

function sendJson(res, code, obj) {
  setCors(res);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text);
    });
    req.on('error', () => resolve(''));
  });
}

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return sendJson(res, 204, { ok: true });
  }

  // Build a URL object for routing and query parsing
  const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = fullUrl.pathname;

  // Health
  if (pathname === '/health' || pathname === '/') {
    return sendJson(res, 200, {
      ok: true,
      env: {
        OMADA_BASE,
        OMADA_CONTROLLER_ID: CTRL,
        OMADA_OPERATOR_USER: Boolean(process.env.OMADA_OPERATOR_USER),
        OMADA_OPERATOR_PASS: Boolean(process.env.OMADA_OPERATOR_PASS),
      },
      routes: {
        authorize:        Boolean(authorize),
        submit_email:     Boolean(submitEmail),
        omada_probe:      Boolean(omadaProbe),
        omada_login_test: Boolean(omadaLoginTest),
        omada_auth_probe: Boolean(omadaAuthProbe),
        omada_ext_auth_min:Boolean(omadaExtAuthMin),
      }
    });
  }

  // For POST routes, read and attach body like Vercel would
  if (req.method === 'POST') {
    const raw = await readBody(req);
    try { req.body = JSON.parse(raw || '{}'); }
    catch { req.body = raw || ''; }
  }

  try {
    if (pathname === '/api/authorize') {
      if (!authorize) return sendJson(res, 500, { ok: false, error: 'authorize handler missing' });
      return authorize(req, res);
    }

    if (pathname === '/api/submit_email') {
      if (!submitEmail) return sendJson(res, 500, { ok: false, error: 'submit_email handler missing' });
      return submitEmail(req, res);
    }

    // Optional local endpoints for Omada debugging
    if (pathname === '/api/omada_probe') {
      if (!omadaProbe) return sendJson(res, 500, { ok: false, error: 'omada_probe handler missing' });
      return omadaProbe(req, res);
    }

    if (pathname === '/api/omada_login_test') {
      if (!omadaLoginTest) return sendJson(res, 500, { ok: false, error: 'omada_login_test handler missing' });
      return omadaLoginTest(req, res);
    }

    if (pathname === '/api/omada_auth_probe') {
      if (!omadaAuthProbe) return sendJson(res, 500, { ok: false, error: 'omada_auth_probe handler missing' });
      return omadaAuthProbe(req, res);
    }

    if (pathname === '/api/omada_ext_auth_min') {
      if (!omadaExtAuthMin) return sendJson(res, 500, { ok: false, error: 'omada_ext_auth_min handler missing' });
      return omadaExtAuthMin(req, res);
    }

    return sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    console.error('[server] route error', err);
    return sendJson(res, 500, { ok: false, error: 'Server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Local API listening on http://${HOST}:${PORT}`);
});
