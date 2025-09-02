// server.js  minimal HTTP server for local testing
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // ok for LAN testing only

const http = require('http');
const { URL } = require('url');

function safeRequire(p) {
  try { return require(p); } catch { return null; }
}

const authorize = safeRequire('./authorize');
const submitEmail = safeRequire('./submit_email');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0');

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
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const text = buf.toString('utf8');
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
      routes: {
        authorize: Boolean(authorize),
        submit_email: Boolean(submitEmail),
      }
    });
  }

  // For POST routes, read and attach body like Vercel would
  if (req.method === 'POST') {
    const raw = await readBody(req);
    // Try to parse JSON, else leave as raw string
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

    return sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    console.error('[server] route error', err);
    return sendJson(res, 500, { ok: false, error: 'Server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Local API listening on http://${HOST}:${PORT}`);
});
