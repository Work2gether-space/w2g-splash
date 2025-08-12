// api/submit_email.js  rollback minimal
module.exports = async (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  } catch {}
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Use POST' });

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    console.log('[submit_email]', { email: body.email, clientMac: body.clientMac, site: body.site });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[submit_email] error', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};
