// Run with Node >= 20 and Redis 7 (redis-server and redis-cli on PATH).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const ingest = require('../api/game-items');
const admin = require('../api/admin');
const origin = 'https://smi-pearl.vercel.app';
const redisUrl = 'https://redis.invalid';
const modToken = 'local-test-only-01234567890123456789';

async function startRedis(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smi-game-items-'));
  const socket = path.join(dir, 'redis.sock');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const child = spawn('redis-server', [
    '--dir', dir, '--port', '0', '--unixsocket', socket,
    '--save', '', '--appendonly', 'no', '--loglevel', 'warning',
  ], { stdio: 'ignore' });
  await once(child, 'spawn');
  const exited = once(child, 'exit');
  t.after(async () => {
    child.kill('SIGTERM');
    await exited;
  });
  const command = async args => {
    const { stdout } = await exec('redis-cli', ['-s', socket, '--json', ...args.map(String)]);
    return JSON.parse(stdout);
  };
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if (await command(['PING']) === 'PONG') return command; } catch (error) {
      if (error.code === 'ENOENT' || child.exitCode !== null) throw error;
    }
    await delay(25);
  }
  throw new Error('Test Redis did not start');
}

async function invoke(handler, { method = 'POST', query = {}, headers, body }) {
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
  await handler({ method, query, headers, body }, res);
  return res;
}

const item = (customModelData, fields = {}) => ({
  material: 'paper', customModelData, name: 'Образец ' + customModelData,
  rarity: 'Rare', price: 125000, ...fields,
});

function upload(items, token = modToken) {
  return invoke(ingest, {
    headers: { 'x-rpm-submission': 'manual', authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: { items },
  });
}

test('game observations and moderation share the existing catalogue and Redis', async t => {
  const redis = await startRedis(t);
  Object.assign(process.env, {
    RPM_ARCHIVE_TOKEN: modToken, ADMIN_PASSWORD: 'local-test-admin-password',
    UPSTASH_REDIS_REST_URL: redisUrl, UPSTASH_REDIS_REST_TOKEN: 'test-redis',
    GITHUB_CONTENTS_TOKEN: 'test-github',
  });
  let community = { version: 1, items: { 'paper:99': { name: 'Известная модель' } }, history: {} };
  let revision = 1, loseCommitResponse = false, redisOffline = false;
  const calls = [];
  const reply = (body, status = 200) => Response.json(body, { status });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(url);
    if (target.origin === redisUrl) {
      assert.equal(options.headers.Authorization, 'Bearer test-redis');
      if (redisOffline) return reply({ error: 'offline' }, 503);
      const cmd = JSON.parse(options.body);
      calls.push(cmd);
      const result = await redis(cmd);
      if (loseCommitResponse && cmd[0] === 'EVAL' && JSON.stringify(cmd).includes('Образец 4')) {
        loseCommitResponse = false;
        throw Error('Simulated lost Redis acknowledgement');
      }
      return reply({ result });
    }
    assert.equal(target.origin, 'https://api.github.com');
    assert.equal(target.pathname, '/repos/nanariikirgb/smi/contents/data/community-items.json');
    assert.equal(options.headers.Authorization, 'Bearer test-github');
    if (options.method === 'GET') {
      return reply({ sha: String(revision), content: Buffer.from(JSON.stringify(community)).toString('base64') });
    }
    assert.equal(options.method, 'PUT');
    const data = JSON.parse(options.body);
    if (data.sha !== String(revision)) return reply({}, 409);
    community = JSON.parse(Buffer.from(data.content, 'base64'));
    revision++;
    return reply({});
  });
  function moderate(action, { method = 'GET', body, cookie = '', query = {} } = {}) {
    return invoke(admin, { method, query: { action, ...query }, headers: { cookie, origin, 'content-type': 'application/json' }, body });
  }

  await t.test('ingestion and moderation use separate credentials', async () => {
    assert.equal((await upload([item(1)], 'incorrect')).statusCode, 401);
    assert.equal((await moderate('game-list')).statusCode, 401);
    assert.equal((await moderate('game-reject', { method: 'POST', body: { id: '1' } })).statusCode, 401);
    assert.equal((await redis(['DBSIZE'])), 0);
  });
  const login = await moderate('login', { method: 'POST', body: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers['set-cookie'].split(';')[0];
  const list = async (mode = 'pending') => {
    const res = await moderate('game-list', { cookie, query: { mode } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    return res.body;
  };

  await t.test('an invalid member rejects the entire batch', async () => {
    for (const extra of [{ owner: 'private' }, { lore: ['owner: private'] }, { rarity: 'private text' }, { price: -1 }]) {
      assert.equal((await upload([item(1), item(2, extra)])).statusCode, 400);
    }
    const oversized = await upload(Array.from({ length: 33 }, (_, i) => item(i + 1)));
    assert.ok([400, 413].includes(oversized.statusCode));
    assert.equal((await list()).total, 0);
  });

  await t.test('old automatic clients and non-catalog objects cannot publish', async () => {
    const old = await invoke(ingest, {headers: {authorization: 'Bearer ' + modToken, 'content-type': 'application/json'}, body: {items: [item(1)]}});
    assert.equal(old.statusCode, 409);
    const ignored = await upload([item(1, {material:'stone'}), item(2147483647, {name:'Неизвестная модель'})]);
    assert.equal(ignored.body.skipped, 2);
    assert.equal(ignored.body.published, 0);
    assert.equal(revision, 1);
  });

  await t.test('concurrent batches publish once, skip known names and appear in history', async () => {
    const items = [item(633, {material:'golden_chestplate'}), item(10, {material:'emerald'}),
      item(80, {material:'sugar'}), item(99), item(1), item(2)];
    const replies = await Promise.all([upload(items), upload(items)]);
    for (const r of replies) {
      assert.equal(r.statusCode, 200);
      assert.equal(r.body.processed, 6);
    }
    assert.equal(revision, 2);
    assert.equal(community.items['paper:99'].name, 'Известная модель');
    assert.equal(community.items['paper:1'].name, item(1).name);
    assert.equal(community.items['paper:2'].name, item(2).name);
    assert.equal((await list()).total, 0);
    assert.equal((await list('history')).total, 3);
    assert.ok((await list('history')).rows.every(row => row.automatic));
    await upload([item(1, {name:'Другое название'})]);
    assert.equal(revision, 2);
  });

  await t.test('lost acknowledgement keeps the published batch idempotent', async () => {
    redisOffline = true;
    assert.equal((await upload([item(4)])).statusCode, 503);
    redisOffline = false;
    loseCommitResponse = true;
    assert.equal((await upload([item(4)])).statusCode, 503);
    assert.equal(loseCommitResponse, false);
    assert.equal((await upload([item(4)])).body.processed, 1);
    assert.equal(revision, 3);
    assert.equal((await list('history')).total, 4);
  });
  await t.test('fill missing fields without replacing names, prices, collections or static lore', async () => {
    community.items['paper:1'].price = null;
    const inputs = [
      item(1, {name:'', collection:'Custom Clothes', price:0}),
      item(2, {collection:'Old Style', price:4}),
      item(633, {material:'golden_chestplate', collection:'Другая', price:1})
    ];
    assert.equal((await upload(inputs)).statusCode, 200);
    const filled = community.items['paper:1'];
    assert.equal(filled.name, item(1).name);
    assert.equal(filled.price, 0);
    assert.equal(filled.collection, 'Custom Clothes');
    assert.equal(community.items['paper:2'].price, 125000);
    assert.equal(community.items['paper:2'].collection, 'Old Style');
    assert.equal(community.items['golden_chestplate:633'], undefined);
    const after = revision;
    await upload([item(1, {name:'Иное', collection:'Иная', price:55})]);
    assert.equal(revision, after);
  });

});
