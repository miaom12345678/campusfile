/**
 * API 入口（Vercel Serverless Function，catch-all 路由）
 * 所有接口都在 /api/* 下，前后端同域，无需 CORS 配置。
 *
 * 身份：请求头 x-user-id。浏览器首次访问会生成一个访客 ID 存在 localStorage，
 * 这样刷新、换标签页、换电脑（同一链接重新生成）都能各自拥有独立数据，
 * 而数据本身存在云端 KV 里，不依赖任何本机进程。
 */
const domain = require('../lib/domain');
const store = require('../lib/store');
const C = require('../lib/categories');

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        resolve({});
      }
    });
  });
}

function seg(req) {
  // 生产环境：/api/publish 经 vercel.json 重写到 /api/index.js，req.url 仍是原路径
  // 本地环境：server.js 直接调用本函数，req.url 同样是 /api/publish
  const p = String(req.pathname || req.url || '').split('?')[0];
  return p.replace(/^\/api\/?/, '').replace(/\/$/, '');
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return send(res, 204, {});

  const path = seg(req);
  const method = req.method || 'GET';
  const userId = String(req.headers['x-user-id'] || '').trim();

  try {
    /* ---------- 无需身份 ---------- */
    if (path === 'health') {
      return send(res, 200, {
        ok: true,
        time: Date.now(),
        version: '3.4-web',
        storage: store.status(),
        vercel: Boolean(process.env.VERCEL)
      });
    }
    if (path === 'config') {
      return send(res, 200, {
        ok: true,
        categories: C.CATEGORIES,
        colors: C.COLORS,
        colorUnknown: C.COLOR_UNKNOWN,
        idCategories: C.ID_CATEGORIES,
        campuses: C.CAMPUS_LOCATIONS,
        maxLocation: C.MAX_LOCATION,
        timeModes: C.TIME_MODES,
        postTypes: C.POST_TYPES,
        couponCost: C.COUPON_COST,
        pointPerReturn: C.POINT_PER_RETURN,
        matchThreshold: require('../lib/match').MATCH_THRESHOLD,
        storage: store.status()
      });
    }

    if (!userId) {
      return send(res, 401, { ok: false, errMsg: '缺少身份标识，请刷新页面重试' });
    }
    await domain.ensureUser(userId);

    /* ---------- GET ---------- */
    if (method === 'GET') {
      if (path === 'posts') {
        return send(res, 200, await domain.listPosts(userId, { type: req.query.type }));
      }
      if (path === 'post') {
        return send(res, 200, await domain.getPostDetail(userId, String(req.query.id || '')));
      }
      if (path === 'search') {
        return send(res, 200, await domain.searchPosts(userId, req.query || {}));
      }
      if (path === 'messages') {
        const list = await domain.listMessages(userId);
        return send(res, 200, { ok: true, list, unread: await domain.unreadCount(userId) });
      }
      if (path === 'claims') {
        return send(res, 200, { ok: true, list: await domain.listMyClaims(userId) });
      }
      if (path === 'me') {
        return send(res, 200, await domain.myCenter(userId));
      }
      return send(res, 404, { ok: false, errMsg: '接口不存在：GET /api/' + path });
    }

    /* ---------- POST ---------- */
    const body = await readBody(req);

    if (path === 'publish') {
      return send(res, 200, await domain.publishPost(userId, body));
    }
    if (path === 'claim') {
      const action = String(body.action || 'create');
      if (action === 'create') return send(res, 200, await domain.createClaim(userId, body));
      if (action === 'accept') return send(res, 200, await domain.acceptClaim(userId, String(body.claimId || '')));
      if (action === 'reject') return send(res, 200, await domain.rejectClaim(userId, String(body.claimId || '')));
      if (action === 'close') return send(res, 200, await domain.closePost(userId, String(body.postId || '')));
      if (action === 'repair') return send(res, 200, await domain.repairPoints(userId, !!body.dryRun));
      return send(res, 400, { ok: false, errMsg: '未知的认领动作：' + action });
    }
    if (path === 'messages') {
      const action = String(body.action || 'readAll');
      if (action === 'readAll') {
        const n = await domain.markAllRead(userId);
        return send(res, 200, { ok: true, updated: n, unread: await domain.unreadCount(userId) });
      }
      if (action === 'readByPost') {
        const n = await domain.markReadByPost(String(body.postId || ''), [userId]);
        return send(res, 200, { ok: true, updated: n, unread: await domain.unreadCount(userId) });
      }
      return send(res, 400, { ok: false, errMsg: '未知的消息动作：' + action });
    }
    if (path === 'reward') {
      const action = String(body.action || 'redeem');
      if (action === 'redeem') return send(res, 200, await domain.redeemCoupon(userId));
      if (action === 'grant') return send(res, 200, await domain.grantPoints(userId, body.points));
      return send(res, 400, { ok: false, errMsg: '未知的奖励动作：' + action });
    }
    if (path === 'seed') {
      return send(res, 200, await domain.seedDemo(userId, !!body.force));
    }
    if (path === 'demo/clear') {
      return send(res, 200, await domain.clearDemo(userId));
    }
    if (path === 'demo/dedupe') {
      return send(res, 200, await domain.dedupe(userId, body.dryRun !== false));
    }

    return send(res, 404, { ok: false, errMsg: '接口不存在：POST /api/' + path });
  } catch (e) {
    console.error('[api] ' + path + ' 失败：', e);
    return send(res, 500, {
      ok: false,
      errMsg: '服务端异常：' + (e && e.message ? e.message : '未知错误'),
      storage: store.status()
    });
  }
}

module.exports = handler;
