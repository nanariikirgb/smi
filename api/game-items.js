const game = require('../lib/game-items');
const m = require('../lib/moderation');

module.exports = async function(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const fail = (status, error) => res.status(status).json({error});
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(405, 'POST required');
  }
  if (!game.tokenOk(req.headers.authorization)) return fail(401, 'Unauthorized');
  if (!m.configured() || !process.env.GITHUB_CONTENTS_TOKEN) return fail(503, 'Storage unavailable');
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return fail(415, 'JSON required');
  if (Number(req.headers['content-length']) > 65536) return fail(413, 'Batch too large');
  let data = req.body;
  if (typeof data === 'string') {
    if (Buffer.byteLength(data) > 65536) return fail(413, 'Batch too large');
    try { data = JSON.parse(data); } catch { return fail(400, 'Invalid JSON'); }
  }
  if (!Array.isArray(data?.items) || !data.items.length || data.items.length > 50) return fail(400, 'Invalid batch');
  if (Buffer.byteLength(JSON.stringify(data)) > 65536) return fail(413, 'Batch too large');
  const items = data.items.map(game.validate);
  if (items.some(item => !item)) return fail(400, 'Invalid item');
  try {
    if (!await m.limit('game:upload', 120, 60)) return fail(429, 'Retry later');
    const queued = await game.ingest(items);
    res.setHeader('X-RPM-Archive-Sync', '1');
    return res.json({ok: true, processed: items.length, queued});
  } catch {
    console.warn('RPM Archive Sync batch failed');
    return fail(503, 'Storage unavailable');
  }
};
