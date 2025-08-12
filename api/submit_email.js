// api/submit_email.js  Vercel Serverless Function - CommonJS
// Forwards the splash form to /api/authorize and passes along the Omada query params.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  try {
    // 1) Read email from body
    const { email = '' } = req.body || {};

    // 2) Pull Omada params from the page URL that opened the form
    //    Vercel gives us the referring page in the Referer header
    const referer = req.headers['referer'] || req.headers['referrer'] || '';
    const u = new URL(referer || `https://${req.headers.host}/`);
    const qs = u.searchParams;

    const payload = {
      email,
      clientMac: qs.get('clientMac') || '',
      apMac: qs.get('apMac') || '',
      ssidName: qs.get('ssidName') || '',
      radioId: qs.get('radioId') || '',
      site: qs.get('site') || '',
      redirectUrl: (() => {
        const r = qs.get('redirectUrl');
        try { return r ? decodeURIComponent(r) : 'http://neverssl.com'; } catch { return 'http://neverssl.com'; }
      })(),
    };

    console.log('[submit_email] forwarding payload', { ...payload, clientMac: '(present if not empty)', apMac: '(present if not empty)' });

    // 3) Forward to our Omada authorizer in the same deployment
    const url = `https://${req.headers.host}/api/authorize`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const text = await resp.text();
    // Bubble up status and body to the browser unchanged
    res.status(resp.status).send(text);
  } catch (err) {
    console.error('[submit_email] error', err);
    res.status(500).json({ ok: false, error: 'Server error in submit_email' });
  }
};
