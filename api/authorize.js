// api/authorize.js  rollback minimal  returns 200 with no controller calls
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Use POST' });

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    console.log('[authorize][rollback] body keys:', Object.keys(body || {}));
    // Do not contact Omada. Just reply 200 so the page remains simple.
    return res.status(200).json({ ok: true, note: 'rollback mode no controller calls' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Server error' });
  }
}
