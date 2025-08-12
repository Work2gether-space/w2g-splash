export const runtime = 'nodejs'

export default async function handler(req, res) {
  console.log('[PING] API was called')
  res.status(200).json({ ok: true })
}
