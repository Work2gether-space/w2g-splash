// api/submit_email.js  (Vercel Serverless Function - CommonJS)

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { email, client_id } = req.body || {};
    if (!email) {
      res.status(400).json({ error: 'Email required' });
      return;
    }

    console.log('Email capture:', {
      email,
      client_id: client_id || 'n/a',
      ua: req.headers['user-agent']
    });

    res.status(200).json({ status: 'saved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
