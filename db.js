/**
 * db.js —— 集合操作（在 store 之上提供 get / list / insert / update 语义）
 * 数据量在几十到几百条量级，采用「整集合读取 + 内存过滤」，避免依赖数据库查询语言。
 */
const store = require('./store');

const COLL = {
  posts: 'posts',
  messages: 'messages',
  claims: 'claims',
  users: 'users',
  coupons: 'coupons'
};

function genId(prefix) {
  return (
    prefix +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
}

async function all(coll) {
  return store.loadAll(coll);
}

async function list(coll, filter) {
  const map = await store.loadAll(coll);
  const arr = Object.keys(map).map((k) => map[k]);
  return filter ? arr.filter(filter) : arr;
}

async function get(coll, id) {
  if (!id) return null;
  const map = await store.loadAll(coll);
  return map[id] || null;
}

async function insert(coll, obj) {
  const id = obj._id || genId(coll.slice(0, 3) + '_');
  const record = Object.assign({}, obj, { _id: id });
  await store.saveOne(coll, id, record);
  return record;
}

async function update(coll, id, patch) {
  const cur = await get(coll, id);
  if (!cur) return null;
  const next = Object.assign({}, cur, patch);
  await store.saveOne(coll, id, next);
  return next;
}

async function remove(coll, id) {
  await store.removeMany(coll, [id]);
}

async function removeWhere(coll, filter) {
  const rows = await list(coll, filter);
  await store.removeMany(coll, rows.map((r) => r._id));
  return rows.length;
}

module.exports = { COLL, genId, all, list, get, insert, update, remove, removeWhere };
