// api/submit_email.js  Vercel Serverless Function - CommonJS
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  try {
    const b = req.body || {};
    const referer = req.headers['referer'] || req.headers['referrer'] || '';
    const u = new URL(referer || `https://${req.headers.host}/`);
    const qs = u.searchParams;

    // prefer values sent in body, else fall back to query string from the splash URL
    const payload = {
      email: b.email || '',
      clientMac: b.clientMac || qs.get('clientMac') || '',
      apMac: b.apMac || qs.get('apMac') || '',
      ssidName: b.ssidName || qs.get('ssidName') || '',
      radioId: b.radioId || qs.get('radioId') || '',
      site: b.site || qs.get('site') || '',
      redirectUrl: (() => {
        const r = b.redirectUrl || qs.get('redirectUrl');
        try { return r ? decodeURIComponent(r) : 'http://neverssl.com'; } catch { return 'http://neverssl.com'; }
      })(),
    };

    console.log('[submit_email] forwarding payload', {
      ...payload,
      clientMac: payload.clientMac ? '(present)' : '',
      apMac: payload.apMac ? '(present)' : ''
    });

    const url = `https://${req.headers.host}/api/authorize`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const text = await resp.text();
    res.status(resp.status).send(text);
  } catch (err) {
    console.error('[submit_email] error', err);
    res.status(500).json({ ok: false, error: 'Server error in submit_email' });
  }
};
