// api/submit_email.js  (Vercel Serverless Function - CommonJS)
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }
  try {
    const { email, client_id } = req.body || {};
    console.log('Email capture:', { email, client_id, ua: req.headers['user-agent'] });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('submit_email error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};
