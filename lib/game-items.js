const {createHash, timingSafeEqual} = require('node:crypto');
const m = require('./moderation');
const base = require('../data/custom-items.json');
const extra = require('../data/catalog-extra.json');

const keyFor = (material, cmd) => material.replace(/^minecraft:/i, '').toLowerCase() + ':' + cmd;
const hasName = value => typeof value === 'string' && !!value.replace(/[§&][0-9a-fk-orx]/gi, '').trim();
const baseline = new Set([
  ...base.items.filter(x => hasName(x.name)).map(x => keyFor(x.material, x.customModelData)),
  ...Object.values(extra).filter(Array.isArray).flat().filter(x => x.item && hasName(x.name)).map(x => keyFor(x.item, x.cmd)),
  ...Object.entries(extra.rewards || {}).filter(([, rows]) => rows.length === 1 && hasName(rows[0].name)).map(([key]) => key)
]);

const digest = value => createHash('sha256').update(value).digest();
const tokenOk = header => {
  const token = process.env.RPM_ARCHIVE_SYNC_TOKEN || '';
  return token.length >= 32 && typeof header === 'string' && header.length <= 512 &&
    timingSafeEqual(digest('Bearer ' + token), digest(header));
};
const nameOk = value => typeof value === 'string' && value.length >= 2 && value.length <= 100 &&
  value === value.trim() && /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u.test(value) &&
  !/[@§]|(?:https?:|www\.)|\d{7}/i.test(value);

function validate(item) {
  if (!item || typeof item.material !== 'string' || !/^[a-z0-9_]{1,64}$/.test(item.material) ||
      !Number.isInteger(item.customModelData) || item.customModelData < 0 || item.customModelData > 2147483647 ||
      !nameOk(item.name) || !Array.isArray(item.lore) || item.lore.length > 2 ||
      item.lore.some(line => typeof line !== 'string' || !/^(?:Стандартная цена: (?:[0-9]{1,12}|[0-9]{1,3}(?:\.[0-9]{3}){1,3})\$|\[(?:Common|Uncommon|Rare|Epic|Legendary|Secret|Limited|Event|Elite|Season|RPMPass)\])$/i.test(line))) return null;
  const {material, customModelData, name, lore} = item;
  const key = keyFor(material, customModelData);
  const id = digest(JSON.stringify([key, name.toLowerCase()])).toString('hex');
  return {id, key, material, customModelData, name, lore};
}

const pending = m.K('game:pending');
const rows = m.K('game:rows');
const seen = m.K('game:seen');

async function ingest(items) {
  const db = await m.community();
  const candidates = items.filter(x => !baseline.has(x.key) && !hasName(db.items[x.key]?.name));
  if (!candidates.length) return 0;
  const now = Date.now();
  return Number(await m.redis('EVAL', `
    local added=0
    for i=2,#ARGV,2 do
      local id=ARGV[i]
      if redis.call('SADD',KEYS[3],id)==1 then
        redis.call('HSET',KEYS[2],id,ARGV[i+1])
        redis.call('ZADD',KEYS[1],ARGV[1],id)
        added=added+1
      end
    end
    return added
  `, 3, pending, rows, seen, now, ...candidates.flatMap(x => [x.id, JSON.stringify({...x, createdAt: new Date(now).toISOString()})])));
}

async function list(offset) {
  const ids = await m.redis('ZREVRANGE', pending, offset, offset + 19);
  const records = ids.length ? await m.redis('HMGET', rows, ...ids) : [];
  return {rows: records.map(m.parse).filter(Boolean), total: Number(await m.redis('ZCARD', pending))};
}

async function decide(id, approve, name) {
  const lockId = 'game:' + id;
  const token = await m.lock(lockId);
  if (!token) return false;
  try {
    const row = m.parse(await m.redis('HGET', rows, id));
    if (!row) return false;
    if (approve) {
      if (baseline.has(row.key)) throw Object.assign(Error('У модели уже есть название в каталоге'), {status: 409});
      const price = row.lore.find(line => /^Стандартная цена:/i.test(line));
      const rarity = row.lore.find(line => line.startsWith('['));
      await m.publish({...row, id: lockId}, {
        name,
        price: price ? Number(price.replace(/\D/g, '')) : null,
        rarity: rarity ? rarity.slice(1, -1) : ''
      });
    }
    return !!await m.redis('EVAL', `
      if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
      redis.call('ZREM',KEYS[2],ARGV[2])
      redis.call('HDEL',KEYS[3],ARGV[2])
      return 1
    `, 3, m.K('lock:' + lockId), pending, rows, token, id);
  } finally {
    await m.unlock(lockId, token);
  }
}

module.exports = {tokenOk, nameOk, validate, ingest, list, decide};
