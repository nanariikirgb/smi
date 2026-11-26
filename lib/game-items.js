const crypto = require('node:crypto');
const m = require('./moderation');
const {hasModel} = require('./game-models');
const custom = require('../data/custom-items.json');
const extra = require('../data/catalog-extra.json');

const prefix = 'smi:game-items:v1:';
const rowsKey = prefix + 'rows';
const pendingKey = prefix + 'pending';
const historyKey = prefix + 'history';
const rarities = new Set(['', 'Event', 'Rare', 'Uncommon', 'Epic', 'RPMPass', 'Common', 'Legendary', 'Season', 'Secret', 'Limited']);
const baseNames = new Set();
function plain(value) {
  return typeof value === 'string' ? value.replace(/[§&][0-9a-fk-orx]/gi, '').replace(/^\s*❙\s*/, '').trim() : '';
}
for (const row of custom.items) {
  if (plain(row.name)) baseNames.add(row.material.toLowerCase() + ':' + row.customModelData);
}
for (const row of extra['vehicle-stats']) {
  if (plain(row.name)) baseNames.add(row.item.replace(/^minecraft:/, '').toLowerCase() + ':' + row.cmd);
}
for (const [key, rewards] of Object.entries(extra.rewards)) {
  if (rewards.length === 1 && plain(rewards[0].name)) baseNames.add(key);
}

// index.html gives an explicit community name, including an empty one, precedence.
function alreadyNamed(key, community) {
  const entry = community.items[key];
  return typeof entry?.name === 'string' ? Boolean(plain(entry.name)) : baseNames.has(key);
}
function problem(status, message) {
  return Object.assign(new Error(message), {status});
}
function objectWithOnly(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => fields.includes(key));
}
function priceOk(price) {
  return price === null || (Number.isSafeInteger(price) && price >= 0 && price <= 1e12);
}
function safeName(name) {
  return typeof name === 'string' && name.length >= 2 && name.length <= 100 && name === name.trim()
    && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069§@]/u.test(name)
    && !/(?:https?:\/\/|www\.|discord\.gg\/|t\.me\/|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{7,}|(?:владелец|владелица|игрок|ник|owner|player)\s*[:=])/iu.test(name);
}
function validateBatch(body) {
  if (!objectWithOnly(body, ['items']) || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 32) {
    throw problem(400, 'Требуется пакет от 1 до 32 предметов');
  }
  return body.items.map(item => {
    if (!objectWithOnly(item, ['material', 'customModelData', 'name', 'price', 'rarity'])) {
      throw problem(400, 'Недопустимые поля предмета');
    }
    const {material, customModelData, name, price = null, rarity = ''} = item;
    if (typeof material !== 'string' || !/^[a-z0-9_]{1,64}$/.test(material)
      || !Number.isInteger(customModelData) || customModelData < 0 || customModelData > 2147483647
      || !safeName(name) || !priceOk(price) || !rarities.has(rarity)) {
      throw problem(400, 'Некорректный предмет или поля Lore');
    }
    return {key: material + ':' + customModelData, material, customModelData, name, suggestedPrice: price, suggestedRarity: rarity};
  });
}

// Bound the queue and preserve an entire batch if capacity is exhausted.
const enqueue = `
  local added = 0
  for i = 2, #ARGV, 2 do
    if redis.call('HEXISTS', KEYS[1], ARGV[i]) == 0 then added = added + 1 end
  end
  if redis.call('ZCARD', KEYS[2]) + added > 2000 then return -1 end
  for i = 2, #ARGV, 2 do
    if redis.call('HSETNX', KEYS[1], ARGV[i], ARGV[i+1]) == 1 then
      redis.call('ZADD', KEYS[2], ARGV[1], ARGV[i])
    end
  end
  return added
`;
async function ingest(items) {
  const unique = new Map();
  let skipped = 0;
  for (const item of items) {
    if (!hasModel(item.key)) { skipped++; continue; }
    const identity = JSON.stringify([item.key, item.name.normalize('NFC').toLowerCase(), item.suggestedPrice, item.suggestedRarity]);
    const id = 'game-' + crypto.createHash('sha256').update(identity).digest('hex');
    unique.set(id, {...item, id});
  }
  const rows = [...unique.values()];
  const db = rows.length ? await m.community() : null;
  const candidates = rows.filter(row => !alreadyNamed(row.key, db) && !db.items[row.key]?.hidden);
  const now = new Date();
  const records = candidates.flatMap(row => [row.id, JSON.stringify({...row, status:'pending', createdAt:now.toISOString()})]);
  const queued = records.length ? Number(await m.redis('EVAL', enqueue, 2, rowsKey, pendingKey, now.getTime(), ...records)) : 0;
  if (queued < 0) throw problem(429, 'Очередь модерации заполнена. Повторите отправку позже.');
  return {ok:true, processed:items.length, published:0, queued, known:rows.length-candidates.length,
    skipped, duplicates:items.length-skipped-rows.length+candidates.length-queued};
}

const listPage = `
  local ids = redis.call('ZREVRANGE', KEYS[1], ARGV[1], ARGV[2])
  local rows = {}
  if #ids > 0 then rows = redis.call('HMGET', KEYS[2], unpack(ids)) end
  return {redis.call('ZCARD', KEYS[1]), rows}
`;
async function list(offset, mode) {
  const index = mode === 'history' ? historyKey : pendingKey;
  const [total, values] = await m.redis('EVAL', listPage, 2, index, rowsKey, offset, offset + 19);
  const rows = values.map(m.parse).map(row => ({...row, indexed: hasModel(row.key)}));
  return {rows, total: Number(total)};
}

const saveDecision = `
  if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
  redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
  redis.call('ZREM', KEYS[3], ARGV[2])
  redis.call('ZADD', KEYS[4], ARGV[4], ARGV[2])
  local excess = redis.call('ZCARD', KEYS[4]) - 5000
  if excess > 0 then
    local oldest = redis.call('ZRANGE', KEYS[4], 0, excess-1)
    for _, id in ipairs(oldest) do redis.call('HDEL', KEYS[2], id); redis.call('ZREM', KEYS[4], id) end
  end
  return 1
`;
async function decide(action, data) {
  if (!data || typeof data.id !== 'string' || !/^game-[a-f0-9]{64}$/.test(data.id)) throw problem(400, 'Неверный ID');
  const id = data.id;
  const token = await m.lock(id);
  if (!token) throw problem(409, 'Предмет уже обрабатывается');
  try {
    const row = m.parse(await m.redis('HGET', rowsKey, id));
    if (!row) throw problem(404, 'Предмет не найден');
    if (row.status !== 'pending') throw problem(409, 'Предмет уже рассмотрен');
    let published;
    if (action === 'game-approve') {
      const name = m.clean(data.name);
      const price = data.price ?? null;
      const rarity = m.clean(data.rarity);
      if (!safeName(name) || !priceOk(price) || rarity.length > 50) throw problem(400, 'Проверьте название, цену и редкость');
      published = await m.publish(row, {name, price, rarity}, db => {
        if (!hasModel(row.key)) throw problem(409, 'Модель пока отсутствует в каталоге ресурс-пака');
        if (db.items[row.key]?.hidden) throw problem(409, 'Модель скрыта в каталоге');
        if (alreadyNamed(row.key, db)) throw problem(409, 'В каталоге уже есть название для этой модели');
      });
    } else {
      // A GitHub commit can succeed even if the subsequent Redis write was interrupted.
      published = await m.previouslyPublished(row);
    }
    const decision = published
      ? {status: 'approved', approvedName: published.name, price: published.price, rarity: published.rarity}
      : {status: 'rejected', reason: m.clean(data.reason).slice(0, 400)};
    const now = new Date();
    const updated = {...row, ...decision, decidedAt: now.toISOString()};
    const saved = await m.redis('EVAL', saveDecision, 4, m.K('lock:' + id), rowsKey, pendingKey, historyKey,
      token, id, JSON.stringify(updated), now.getTime());
    if (!Number(saved)) throw problem(409, 'Блокировка истекла. Повторите действие.');
    return {...updated, indexed: hasModel(row.key)};
  } finally {
    await m.unlock(id, token);
  }
}

module.exports = {validateBatch, ingest, list, decide};
