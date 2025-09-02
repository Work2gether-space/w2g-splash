// api/submit_email.js
// Vercel Serverless Function - CommonJS

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  try {
    // Body may be an object (Vercel auto JSON) or raw string
    const rawBody = req.body;
    const b = typeof rawBody === 'string' ? safeJson(rawBody) : (rawBody || {});

    // Build two query sources: current request URL and the page referer
    const host = req.headers.host || 'localhost';
    const reqURL = safeUrl(`https://${host}${req.url || '/api/submit_email'}`);
    const refURL = safeUrl(req.headers['referer'] || req.headers['referrer'] || '');

    const reqQS = reqURL.searchParams;
    const refQS = refURL ? refURL.searchParams : new URLSearchParams();

    // Helper to read first non-empty value across body and both query sources
    const pick = (...keys) => {
      for (const k of keys) {
        const bv = vStr(b[k]);
        if (bv) return bv;
        const qv1 = vStr(reqQS.get(k));
        if (qv1) return qv1;
        const qv2 = vStr(refQS.get(k));
        if (qv2) return qv2;
      }
      return '';
    };

    // Debug probe from header or query
    const debugProbe =
      vStr(req.headers['x-debug-probe']) ||
      vStr(reqQS.get('debug')) ||
      vStr(refQS.get('debug')) ||
      '';

    const redirectUrl = normalizeRedirect(
      pick('redirectUrl')
    ) || 'http://neverssl.com';

    // Keep radioId as string
    const radioId = pick('radioId', 'radio');

    const payload = {
      email: pick('email'),
      clientMac: pick('clientMac', 'client_id'),
      apMac: pick('apMac', 'gatewayMac'),
      ssidName: pick('ssidName', 'ssid'),
      radioId, // do not coerce to number
      site: pick('site', 'siteId'),
      redirectUrl,
      extend: strToBool(pick('extend')) || false
    };

    // Log without exposing MACs
    console.log('[submit_email] forwarding payload', {
      ...payload,
      clientMac: payload.clientMac ? '(present)' : '',
      apMac: payload.apMac ? '(present)' : ''
    });

    const target = new URL('/api/authorize', `https://${host}`);
    const headers = { 'Content-Type': 'application/json' };
    if (debugProbe) headers['X-Debug-Probe'] = debugProbe;

    const resp = await fetch(target.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      redirect: 'manual'
    });

    const text = await resp.text();
    res.status(resp.status).send(text);
  } catch (err) {
    console.error('[submit_email] error', err);
    res.status(500).json({ ok: false, error: 'Server error in submit_email' });
  }
};

// ---------- helpers ----------
function safeJson(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

function safeUrl(str) {
  try { return new URL(str); } catch { return null; }
}

function vStr(v) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  return s;
}

function strToBool(v) {
  const s = vStr(v).toLowerCase();
  if (!s) return false;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function normalizeRedirect(url) {
  const s = vStr(url);
  if (!s) return 'http://neverssl.com';
  let v = s;
  try { v = decodeURIComponent(s); } catch {}
  if (/captiveportal|connecttest|generate_204|msftconnecttest|wifiportal/i.test(v)) {
    return 'http://neverssl.com';
  }
  return v;
}
