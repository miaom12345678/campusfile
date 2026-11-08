/**
 * store.js —— 存储适配层
 * ------------------------------------------------
 * 同一套接口支持两种后端，部署到 Vercel 时自动使用 Redis（Upstash / Vercel KV），
 * 本地开发时退化为项目内的 JSON 文件，保证「刷新不丢数据」这条验收标准。
 *
 * 环境变量（Vercel 里配置任意一组即可）：
 *   KV_REST_API_URL + KV_REST_API_TOKEN            （Vercel KV / Marketplace 一键创建时自动注入）
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 */
const fs = require('fs');
const path = require('path');

const REDIS_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const PREFIX = process.env.STORE_PREFIX || 'clf';
const FILE = process.env.DATA_FILE || path.join(process.cwd(), '.data', 'db.json');

const useRedis = Boolean(REDIS_URL && REDIS_TOKEN);

function key(coll) {
  return PREFIX + ':' + coll;
}

async function pipeline(commands) {
  const res = await fetch(REDIS_URL + '/pipeline', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + REDIS_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(commands)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Redis 请求失败 ' + res.status + '：' + text.slice(0, 200));
  }
  const arr = await res.json();
  return arr.map((x) => x.result);
}

/* ---------------- 文件后端（本地开发） ---------------- */
function readFileDb() {
  try {
    const txt = fs.readFileSync(FILE, 'utf8');
    return JSON.parse(txt);
  } catch (e) {
    return {};
  }
}

function writeFileDb(data) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

/* ---------------- 对外接口 ---------------- */
/** 读取整个集合：{ id: obj } */
async function loadAll(coll) {
  if (useRedis) {
    const [flat] = await pipeline([['HGETALL', key(coll)]]);
    const out = {};
    if (Array.isArray(flat)) {
      for (let i = 0; i < flat.length; i += 2) {
        try {
          out[flat[i]] = JSON.parse(flat[i + 1]);
        } catch (e) {
          /* 跳过损坏数据 */
        }
      }
    }
    return out;
  }
  const db = readFileDb();
  return Object.assign({}, db[coll] || {});
}

async function saveOne(coll, id, obj) {
  if (useRedis) {
    await pipeline([['HSET', key(coll), id, JSON.stringify(obj)]]);
    return obj;
  }
  const db = readFileDb();
  db[coll] = db[coll] || {};
  db[coll][id] = obj;
  writeFileDb(db);
  return obj;
}

async function saveMany(coll, items) {
  if (!items.length) return;
  if (useRedis) {
    const cmd = ['HSET', key(coll)];
    items.forEach((it) => {
      cmd.push(it._id, JSON.stringify(it));
    });
    await pipeline([cmd]);
    return;
  }
  const db = readFileDb();
  db[coll] = db[coll] || {};
  items.forEach((it) => {
    db[coll][it._id] = it;
  });
  writeFileDb(db);
}

async function removeMany(coll, ids) {
  if (!ids.length) return;
  if (useRedis) {
    await pipeline([['HDEL', key(coll)].concat(ids)]);
    return;
  }
  const db = readFileDb();
  if (!db[coll]) return;
  ids.forEach((id) => delete db[coll][id]);
  writeFileDb(db);
}

function status() {
  return {
    backend: useRedis ? 'redis' : 'file',
    persistent: useRedis,
    redisHost: useRedis ? REDIS_URL.replace(/^https?:\/\//, '').split('.')[0] : '',
    file: useRedis ? '' : FILE
  };
}

module.exports = { loadAll, saveOne, saveMany, removeMany, status, useRedis };
