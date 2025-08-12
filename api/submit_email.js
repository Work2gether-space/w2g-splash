// api/submit_email.js  (Vercel Serverless Function - CommonJS)

function setCors(res) {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  } catch {}
}

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const {
      email,
      client_id,
      // allow extra fields from splash if you pass them
      clientMac,
      apMac,
      ssidName,
      radioId,
      site
    } = body;

    if (!isValidEmail(email)) {
      return res.status(400).json({ ok: false, error: 'Invalid email' });
    }

    // Store or forward email here if desired. For now, log it.
    console.log('Email capture', {
      email,
      client_id,
      clientMac,
      apMac,
      ssidName,
      radioId,
      site,
      ua: req.headers['user-agent']
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('submit_email error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};
