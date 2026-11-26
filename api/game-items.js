const crypto = require('node:crypto');
const moderation = require('../lib/moderation');
const gameItems = require('../lib/game-items');

const maxBytes = 32 * 1024;
const digest = value => crypto.createHash('sha256').update(value).digest();

module.exports = async function(req, res) {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const fail = (status, error) => res.status(status).json({error});
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(405, 'Требуется POST');
  }
  const secret = process.env.RPM_ARCHIVE_TOKEN || '';
  if (!/^[!-~]{32,256}$/.test(secret) || !moderation.configured() || !process.env.GITHUB_CONTENTS_TOKEN) {
    return fail(503, 'Синхронизация ещё не настроена');
  }
  const bearer = /^Bearer ([!-~]{32,256})$/.exec(req.headers.authorization || '');
  if (!bearer || !crypto.timingSafeEqual(digest(bearer[1]), digest(secret))) return fail(401, 'Неверный токен');
  if (req.headers['x-rpm-submission'] !== 'manual') return fail(409, 'Обновите мод и отправьте кэш из настроек');
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    return fail(415, 'Требуется JSON');
  }
  if (Number(req.headers['content-length']) > maxBytes) return fail(413, 'Слишком большой запрос');
  let items;
  try {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (!raw) return fail(400, 'Требуется пакет предметов');
    if (Buffer.byteLength(raw) > maxBytes) return fail(413, 'Слишком большой запрос');
    items = gameItems.validateBatch(typeof req.body === 'string' ? JSON.parse(raw) : req.body);
  } catch (e) {
    return fail(400, e.status === 400 ? e.message : 'Некорректный JSON');
  }
  try {
    if (!await moderation.limit('game-ingest', 60, 60)) {
      res.setHeader('Retry-After', '60');
      return fail(429, 'Лимит пакетов. Повторите через минуту.');
    }
    return res.json(await gameItems.ingest(items));
  } catch {
    return fail(503, 'Каталог или хранилище временно недоступны');
  }
};
