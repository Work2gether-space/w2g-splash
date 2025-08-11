console.log("DEBUG: authorize.js build version 2025-08-11a");

// api/authorize.js — fetch-only implementation (no axios, no cookie-jar)
// Node 18+ on Vercel has global fetch.
// Uses NODE_TLS_REJECT_UNAUTHORIZED=0 (set in env) to accept OC200 self-signed cert.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Use POST' });
    return;
  }

  const buildId = '2025-08-11c';
  try {
    const {
      OMADA_BASE,
      OMADA_OPERATOR_USER,
      OMADA_OPERATOR_PASS,
      SESSION_MINUTES = '240',
    } = process.env;

    if (!OMADA_BASE || !OMADA_OPERATOR_USER || !OMADA_OPERATOR_PASS) {
      console.error('ENV MISSING', { hasBase: !!OMADA_BASE, hasUser: !!OMADA_OPERATOR_USER, hasPass: !!OMADA_OPERATOR_PASS });
      res.status(500).json({ ok: false, error: 'Missing env vars' });
      return;
    }

    const body = await safeJson(req);
    const {
      clientMac = '',
      apMac = '',
      ssidName = '',
      radioId = '',
      site = '',
      clientIp = '',
      redirectUrl = 'http://neverssl.com',
      email = '',
    } = body || {};

    console.log('DEBUG: authorize.js build', buildId);
    console.log('REQUEST BODY (redacted):', {
      clientMac, apMac, ssidName, radioId, site, clientIp,
      redirectUrl, emailRedacted: email ? 'yes' : 'no'
    });

    if (!clientMac || !site) {
      res.status(400).json({ ok: false, error: 'Missing clientMac or site' });
      return;
    }

    // Normalize base; try common controller prefixes in order
    const bases = normalizeBases(OMADA_BASE);

    // Attempt login on the first base that responds
    let loginResult = null;
    for (const base of bases) {
      loginResult = await hotspotLogin(base, OMADA_OPERATOR_USER, OMADA_OPERATOR_PASS);
      if (loginResult.ok) {
        loginResult.base = base;
        break;
      }
      console.warn('LOGIN failed on base', base, 'detail:', loginResult.detail);
    }

    if (!loginResult || !loginResult.ok) {
      console.error('LOGIN failed on all bases');
      res.status(502).json({ ok: false, error: 'Hotspot login failed', detail: loginResult?.detail || null });
      return;
    }

    const { base: goodBase, cookie, csrf } = loginResult;

    // Build authorization payload
    const timeMicros = String(BigInt(SESSION_MINUTES) * 60n * 1_000_000n);
    const authPayload = {
      clientMac,
      apMac,
      ssidName,
      radioId: radioId ? Number(radioId) : 1,
      site,
      time: timeMicros,
      authType: 4, // external portal
    };

    const authResp = await fetch(`${goodBase}/api/v2/hotspot/extPortal/auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Csrf-Token': csrf,
        'Cookie': cookie,
      },
      body: JSON.stringify(authPayload),
    });

    const authText = await authResp.text();
    let authJson = {};
    try { authJson = JSON.parse(authText); } catch {}

    if (!authResp.ok || !authJson || authJson.errorCode !== 0) {
      console.error('AUTH failed', {
        status: authResp.status, statusText: authResp.statusText, body: authText
      });
      res.status(502).json({ ok: false, error: 'Authorization failed', detail: authJson || authText });
      return;
    }

    console.log('AUTH OK', { base: goodBase, site, clientMac });
    res.json({ ok: true, redirectUrl });
  } catch (err) {
    console.error('authorize handler error:', err?.stack || err);
    res.status(500).json({ ok: false, error: err.message || 'Internal error' });
  }
}

/* ---------------------- helpers ---------------------- */

function normalizeBases(raw) {
  // Strip trailing slashes
  const root = String(raw).replace(/\/+$/, '');

  // If caller already included /omada or /omadac, try that first
  const lower = root.toLowerCase();
  if (lower.endsWith('/omada') || lower.endsWith('/omadac')) {
    return [root, root.replace(/\/omadac$/i, ''), root.replace(/\/omada$/i, '')];
  }

  // Otherwise try common bases in order
  return [`${root}/omada`, `${root}/omadac`, root];
}

async function hotspotLogin(base, name, password) {
  try {
    const r = await fetch(`${base}/api/v2/hotspot/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ name, password }),
    });

    const text = await r.text();
    let json = {};
    try { json = JSON.parse(text); } catch {}

    // Expect { errorCode: 0, result: { token: '...' } } and a Set-Cookie header
    const csrf = json?.result?.token || '';
    const setCookie = r.headers.get('set-cookie') || '';

    if (!r.ok || json?.errorCode !== 0 || !csrf || !setCookie) {
      return { ok: false, detail: { status: r.status, body: text } };
    }

    // Pass along cookie string as-is
    return { ok: true, csrf, cookie: setCookie };
  } catch (e) {
    return { ok: false, detail: e.message || String(e) };
  }
}

async function safeJson(req) {
  try {
    const buf = await getRawBody(req);
    if (!buf || !buf.length) return {};
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return {};
  }
}

// Read raw body (Vercel node runtime)
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
