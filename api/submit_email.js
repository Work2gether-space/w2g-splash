export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email, client_id } = req.body || {};
    if (!email || !client_id) {
      return res.status(400).json({ error: 'Email and client_id required' });
    }

    // For now, just log it. (We’ll wire Nexudus/Omada next.)
    console.log('Email capture:', { email, client_id, ua: req.headers['user-agent'] });

    return res.status(200).json({ status: 'saved' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}
