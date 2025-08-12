// server.js — minimal HTTP server to host authorize.js on port 3000
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // ok for LAN testing only

const http = require('http');
const url = require('url');
const handler = require('./authorize'); // the file you just added

const server = http.createServer((req, res) => {
  const { pathname } = url.parse(req.url, true);
  if (pathname === '/api/authorize') {
    return handler(req, res);
  }
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Authorize server listening on http://localhost:${PORT}`);
});
