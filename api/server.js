// server.js  minimal HTTP server for local testing
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // ok for LAN testing only

const http = require('http');
const url = require('url');

function safeRequire(p) {
  try { return require(p); } catch { return null; }
}

const authorize = safeRequire('./authorize');
const submitEmail = safeRequire('./submit_email');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

function setCors(res) {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Csrf-Token, X-Csrf-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  } catch {}
}

function sendJson(res, code, obj) {
  setCors(res);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  const { pathname } = url.parse(req.url, true);

  // quick health check
  if (pathname === '/health' || pathname === '/') {
    if (req.method === 'OPTIONS') return sendJson(res, 204, { ok: true });
    return sendJson(res, 200, {
      ok: true,
      routes: {
        authorize: Boolean(authorize),
        submit_email: Boolean(submitEmail),
      }
    });
  }

  if (req.method === 'OPTIONS') {
    return sendJson(res, 204, { ok: true });
  }

  if (pathname === '/api/authorize') {
    if (!authorize) return sendJson(res, 500, { ok: false, error: 'authorize handler missing' });
    return authorize(req, res);
  }

  if (pathname === '/api/submit_email') {
    if (!submitEmail) return sendJson(res, 500, { ok: false, error: 'submit_email handler missing' });
    return submitEmail(req, res);
  }

  return sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`Local API listening on http://${HOST}:${PORT}`);
});
