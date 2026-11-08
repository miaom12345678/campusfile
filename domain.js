/**
 * domain.js —— 全部业务逻辑（发布 / 匹配 / 搜索 / 认领 / 消息 / 积分 / 券 / 演示数据）
 * 规则与微信小程序 v3.4 保持一致：
 *   - 只在 lost ↔ found 之间交叉打分，阈值 60
 *   - 发帖限流：60 秒 1 条、24 小时 5 条
 *   - 招领帖主「结束信息」+1 积分（同一帖只一次）；同意认领同样 +1，两条路径一致
 *   - 2 分兑换 1 张餐券，8 位核销码，每日上限 3 张
 *   - 证件号完整号码只存服务端，出参一律删除，页面只显示后四位
 */
const db = require('./db');
const { COLL } = db;
const { computeMatchScore, MATCH_THRESHOLD } = require('./match');
const C = require('./categories');

const DAY = 24 * 60 * 60 * 1000;
const MATCH_WINDOW_DAYS = 180;
const MAX_CANDIDATE = 200;
const MIN_INTERVAL_MS = 60 * 1000;
const DAILY_LIMIT = 5;
const POINT_PER_RETURN = 1;
const COUPON_COST = 2;
const COUPON_DAILY_LIMIT = 3;
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/* ---------------- 通用工具 ---------------- */
function now() {
  return Date.now();
}

function levelOf(score) {
  if (score >= 85) return { level: 'high', levelText: '高度匹配' };
  if (score >= 70) return { level: 'mid', levelText: '较匹配' };
  return { level: 'low', levelText: '可能匹配' };
}

/** 删除敏感字段 + 联系方式按可见性处理 */
function sanitize(post, viewerId, contactVisible) {
  if (!post) return null;
  const out = Object.assign({}, post);
  delete out.sensitive;
  if (!contactVisible) out.contact = null;
  out.isMine = post.userId === viewerId;
  return out;
}

function pickLocations(raw) {
  let list = [];
  if (Array.isArray(raw) && raw.length) {
    list = raw
      .filter((x) => x && x.campus)
      .map((x) => ({ campus: String(x.campus), building: String(x.building || '') }));
  } else if (raw && raw.campus) {
    list = [{ campus: String(raw.campus), building: String(raw.building || '') }];
  }
  return list.slice(0, C.MAX_LOCATION);
}

function normId(raw) {
  return String(raw || '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
}

function genCouponCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

/* ---------------- 用户与积分 ---------------- */
async function ensureUser(userId) {
  const rows = await db.list(COLL.users, (u) => u._id === userId || u.userId === userId);
  if (rows.length) return rows[0];
  return db.insert(COLL.users, {
    _id: userId,
    userId,
    points: 0,
    nickname: '同学' + userId.slice(-4),
    createTime: now(),
    updateTime: now()
  });
}

async function addPoints(userId, delta) {
  const user = await ensureUser(userId);
  const next = (Number(user.points) || 0) + delta;
  await db.update(COLL.users, user._id, { points: next, updateTime: now() });
  console.log('[points] ' + (delta > 0 ? '+' : '') + delta + ' → ' + userId + '，当前 ' + next);
  return next;
}

async function readPoints(userId) {
  const user = await ensureUser(userId);
  return Number(user.points) || 0;
}

/* ---------------- 消息 ---------------- */
async function pushMessage(msg) {
  return db.insert(COLL.messages, Object.assign({ read: false, createTime: now() }, msg));
}

async function unreadCount(userId) {
  const rows = await db.list(COLL.messages, (m) => m.toUserId === userId && m.read === false);
  return rows.length;
}

async function listMessages(userId) {
  const rows = await db.list(COLL.messages, (m) => m.toUserId === userId);
  rows.sort((a, b) => (b.createTime || 0) - (a.createTime || 0));
  // 补上关联帖子摘要，方便列表直接展示
  const posts = await db.all(COLL.posts);
  return rows.slice(0, 100).map((m) => {
    const p = posts[m.postId] || null;
    const mp = posts[m.matchPostId] || null;
    return Object.assign({}, m, {
      postSummary: p ? { _id: p._id, type: p.type, category: p.category, description: p.description, status: p.status } : null,
      matchSummary: mp ? { _id: mp._id, type: mp.type, category: mp.category, description: mp.description } : null
    });
  });
}

/** 把某帖相关的未读消息置为已读，只处理指定用户的 */
async function markReadByPost(postId, userIds) {
  const rows = await db.list(
    COLL.messages,
    (m) => m.postId === postId && m.read === false && userIds.indexOf(m.toUserId) >= 0
  );
  for (const m of rows) {
    await db.update(COLL.messages, m._id, { read: true, readTime: now() });
  }
  return rows.length;
}

async function markAllRead(userId) {
  const rows = await db.list(COLL.messages, (m) => m.toUserId === userId && m.read === false);
  for (const m of rows) {
    await db.update(COLL.messages, m._id, { read: true, readTime: now() });
  }
  return rows.length;
}

/* ---------------- 发布 + 反向匹配 ---------------- */
async function publishPost(userId, input) {
  await ensureUser(userId);
  const type = input.type === 'found' ? 'found' : 'lost';
  const category = String(input.category || '').trim();
  const description = String(input.description || '').trim();
  const locations = pickLocations(input.locations || input);
  const color = String(input.color || '').trim();
  const brand = String(input.brand || '').trim();
  const contact = {
    wechat: String((input.contact && input.contact.wechat) || '').trim(),
    phone: String((input.contact && input.contact.phone) || '').trim()
  };

  if (!category) return { ok: false, errMsg: '请选择物品类别' };
  if (description.length < 5) return { ok: false, errMsg: '请把物品特征写清楚一些（至少 5 个字）' };
  if (!locations.length) return { ok: false, errMsg: '请至少选择 1 个地点' };
  if (!contact.wechat && !contact.phone) return { ok: false, errMsg: '请至少留一种联系方式' };

  // 限流
  const mine = await db.list(COLL.posts, (p) => p.userId === userId);
  mine.sort((a, b) => (b.createTime || 0) - (a.createTime || 0));
  const t = now();
  if (mine.length && t - (mine[0].createTime || 0) < MIN_INTERVAL_MS) {
    const wait = Math.ceil((MIN_INTERVAL_MS - (t - mine[0].createTime)) / 1000);
    return { ok: false, errMsg: '发帖太快了，请 ' + wait + ' 秒后再试（每人 60 秒 1 条）' };
  }
  const dayCount = mine.filter((p) => t - (p.createTime || 0) < DAY).length;
  if (dayCount >= DAILY_LIMIT) {
    return { ok: false, errMsg: '24 小时内最多发布 5 条，明天再来吧' };
  }

  // 时间：day / range / unknown
  const timeMode = input.timeMode === 'range' || input.timeMode === 'unknown' ? input.timeMode : 'day';
  let eventTime = 0;
  let eventTimeEnd = 0;
  let timeUnknown = false;
  if (timeMode === 'unknown') {
    timeUnknown = true;
  } else {
    eventTime = Number(input.eventTime) || 0;
    if (!eventTime) return { ok: false, errMsg: '请选择时间，或选择「记不清了」' };
    if (timeMode === 'range') {
      eventTimeEnd = Number(input.eventTimeEnd) || 0;
      if (!eventTimeEnd || eventTimeEnd < eventTime) {
        return { ok: false, errMsg: '时间段的结束时间不能早于开始时间' };
      }
    }
  }

  // 证件号：只有证件类才保存完整号码，页面上只留后四位
  const idNumber = normId(input.idNumber);
  const sensitive = idNumber.length >= 4 ? { idNumber } : undefined;
  const idTail = sensitive ? '****' + idNumber.slice(-4) : '';

  const post = {
    type,
    category,
    color,
    brand,
    locations,
    campus: locations[0].campus,
    building: locations[0].building,
    eventTime,
    eventTimeEnd,
    timeUnknown,
    timeMode,
    description,
    contact,
    images: [],
    status: 'active',
    userId,
    idTail,
    demo: false,
    createTime: t,
    updateTime: t
  };
  if (sensitive) post.sensitive = sensitive;

  const saved = await db.insert(COLL.posts, post);

  // 反向候选
  const opposite = type === 'lost' ? 'found' : 'lost';
  const candidates = (await db.list(COLL.posts, (p) => {
    if (p.type !== opposite || p.status !== 'active') return false;
    if (p.userId === userId) return false;
    if (p.createTime && t - p.createTime > MATCH_WINDOW_DAYS * DAY) return false;
    return true;
  }))
    .sort((a, b) => (b.createTime || 0) - (a.createTime || 0))
    .slice(0, MAX_CANDIDATE);

  const hits = [];
  for (const c of candidates) {
    const r = computeMatchScore(saved, c);
    if (!r.hit) continue;
    const lv = levelOf(r.score);
    hits.push({
      postId: c._id,
      toUserId: c.userId,
      score: r.score,
      level: lv.level,
      levelText: lv.levelText,
      reasons: r.reasons,
      summary: {
        _id: c._id,
        type: c.type,
        category: c.category,
        color: c.color,
        locations: c.locations || [],
        eventTime: c.eventTime,
        eventTimeEnd: c.eventTimeEnd || 0,
        timeUnknown: !!c.timeUnknown,
        description: c.description,
        idTail: c.idTail || '',
        images: c.images || []
      }
    });
  }
  hits.sort((a, b) => b.score - a.score);

  // 同一对帖子只提醒一次
  let inserted = 0;
  if (hits.length) {
    const exist = await db.list(
      COLL.messages,
      (m) => m.matchPostId === saved._id && hits.some((h) => h.postId === m.postId)
    );
    const keys = {};
    exist.forEach((m) => (keys[m.postId + '|' + m.matchPostId] = true));

    for (const h of hits) {
      if (keys[h.postId + '|' + saved._id]) continue;
      await pushMessage({
        toUserId: h.toUserId,
        type: 'match',
        postId: h.postId,
        matchPostId: saved._id,
        fromUserId: userId,
        title: (type === 'lost' ? '有人捡到了：' : '有人在找：') + category,
        content:
          (type === 'lost' ? '有人发布了失物信息，和你的招领帖匹配度 ' : '有人发布了招领信息，和你的失物帖匹配度 ') +
          h.score +
          ' 分',
        score: h.score,
        reasons: h.reasons
      });
      inserted++;
    }
  }

  const highHits = hits.filter((h) => h.score >= 85);
  const topMatches = (highHits.length ? highHits.slice(0, 8) : hits.slice(0, 3)).map((h) => ({
    postId: h.postId,
    score: h.score,
    levelText: h.levelText,
    reasons: h.reasons,
    summary: h.summary
  }));

  return {
    ok: true,
    postId: saved._id,
    matchCount: inserted,
    highCount: highHits.length,
    threshold: MATCH_THRESHOLD,
    topMatches
  };
}

/* ---------------- 列表 / 详情 ---------------- */
async function listPosts(userId, opts) {
  const type = opts && opts.type;
  const rows = await db.list(COLL.posts, (p) => p.status === 'active');
  rows.sort((a, b) => (b.createTime || 0) - (a.createTime || 0));
  const filtered = type === 'lost' || type === 'found' ? rows.filter((p) => p.type === type) : rows;
  const list = filtered.slice(0, 60).map((p) => sanitize(p, userId, false));
  return { ok: true, list, total: filtered.length };
}

async function getPostDetail(userId, postId) {
  const post = await db.get(COLL.posts, postId);
  if (!post) return { ok: false, errMsg: '帖子不存在或已被删除' };
  const isOwner = post.userId === userId;

  const claims = await db.list(COLL.claims, (c) => c.postId === postId);
  const mine = claims.find((c) => c.claimerId === userId);
  const accepted = claims.find((c) => c.status === 'accepted');
  const contactVisible = isOwner || Boolean(mine && mine.status === 'accepted');

  // 进入详情即清掉该帖给我的未读提醒
  if (userId) await markReadByPost(postId, [userId]);

  const detail = sanitize(post, userId, contactVisible);
  detail.contactVisible = contactVisible;

  const result = {
    ok: true,
    post: detail,
    isOwner,
    myClaim: mine
      ? { _id: mine._id, status: mine.status, message: mine.message, createTime: mine.createTime }
      : null,
    incoming: [],
    matchedScore: null
  };

  if (isOwner) {
    const users = await db.all(COLL.users);
    result.incoming = claims
      .filter((c) => c.status === 'pending')
      .sort((a, b) => (b.createTime || 0) - (a.createTime || 0))
      .map((c) => ({
        _id: c._id,
        message: c.message,
        createTime: c.createTime,
        claimerName: (users[c.claimerId] && users[c.claimerId].nickname) || '同学',
        claimerContact: c.claimerContact || {}
      }));
    result.acceptedClaim = accepted
      ? {
          _id: accepted._id,
          claimerName: (users[accepted.claimerId] && users[accepted.claimerId].nickname) || '同学',
          claimerContact: accepted.claimerContact || {}
        }
      : null;
  }

  // 与「我发的帖子」比对，告诉用户这条是怎么被推给他的
  const myPosts = await db.list(COLL.posts, (p) => p.userId === userId && p.type !== post.type);
  if (myPosts.length) {
    let best = 0;
    myPosts.forEach((p) => {
      const r = computeMatchScore(p, post);
      if (r.score > best) best = r.score;
    });
    result.matchedScore = best;
  }
  return result;
}

/* ---------------- 搜索 ---------------- */
function guessFromKeyword(kw) {
  const out = { category: '', color: '' };
  if (!kw) return out;
  C.CATEGORIES.forEach((c) => {
    if (kw.indexOf(c.split('/')[0]) >= 0) out.category = out.category || c;
  });
  C.COLORS.forEach((c) => {
    if (c !== C.COLOR_UNKNOWN && kw.indexOf(c) >= 0) out.color = out.color || c;
  });
  return out;
}

async function searchPosts(userId, q) {
  const kw = String(q.kw || q.keyword || '').trim();
  const filters = {
    category: String(q.category || ''),
    color: String(q.color || ''),
    campus: String(q.campus || ''),
    building: String(q.building || ''),
    eventTime: Number(q.eventTime) || 0,
    description: kw
  };
  const rows = await db.list(COLL.posts, (p) => p.status === 'active');
  const hasFilter = Boolean(
    filters.category || filters.color || filters.campus || filters.building || filters.eventTime || kw
  );

  if (!hasFilter) {
    rows.sort((a, b) => (b.createTime || 0) - (a.createTime || 0));
    return { ok: true, total: rows.length, keywordUsed: '', list: rows.slice(0, 60).map((p) => sanitize(p, userId, false)) };
  }

  const guess = guessFromKeyword(kw);
  const scored = rows.map((p) => {
    const ref = {
      type: p.type === 'lost' ? 'found' : 'lost',
      category: filters.category || guess.category || '',
      color: filters.color || guess.color || '',
      brand: '',
      locations: filters.campus
        ? [{ campus: filters.campus, building: filters.building || '' }]
        : [],
      eventTime: filters.eventTime,
      description: filters.description
    };
    const r = computeMatchScore(ref, p);
    return { post: p, score: r.score, reasons: r.reasons, level: levelOf(r.score) };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.post.createTime || 0) - (a.post.createTime || 0);
  });

  // 有关键词/筛选时，0 分结果对用户没有意义，直接过滤（避免搜「手机」返回水杯）
  const useful = scored.filter((s) => s.score > 0);

  return {
    ok: true,
    total: useful.length,
    keywordUsed: guess.category || guess.color ? '已识别：' + [guess.category, guess.color].filter(Boolean).join(' / ') : '',
    list: useful.slice(0, 60).map((s) =>
      Object.assign(sanitize(s.post, userId, false), {
        matchScore: s.score,
        matchReasons: s.reasons,
        matchLevel: s.level.level,
        matchLevelText: s.level.levelText
      })
    )
  };
}

/* ---------------- 认领 ---------------- */
function pairKeyOf(a, b) {
  return [a, b].sort().join('|');
}

async function createClaim(userId, input) {
  const post = await db.get(COLL.posts, input.postId);
  if (!post) return { ok: false, errMsg: '帖子不存在' };
  if (post.userId === userId) return { ok: false, errMsg: '不能认领自己发布的帖子' };
  if (post.status !== 'active') return { ok: false, errMsg: '这条信息已经结束了，无法认领' };

  const exists = await db.list(
    COLL.claims,
    (c) => c.postId === post._id && c.claimerId === userId && c.status === 'pending'
  );
  if (exists.length) return { ok: false, errMsg: '你已经提交过申请，等待对方确认即可' };

  const message = String(input.message || '').trim();
  if (message.length < 5) return { ok: false, errMsg: '请描述能证明物品归属的细节（至少 5 个字）' };

  const claimerContact = {
    wechat: String((input.contact && input.contact.wechat) || '').trim(),
    phone: String((input.contact && input.contact.phone) || '').trim()
  };
  if (!claimerContact.wechat && !claimerContact.phone) {
    return { ok: false, errMsg: '请至少留一种联系方式，方便对方联系你' };
  }

  const claim = await db.insert(COLL.claims, {
    postId: post._id,
    ownerId: post.userId,
    claimerId: userId,
    message,
    claimerContact,
    status: 'pending',
    postType: post.type,
    postCategory: post.category,
    pairKey: pairKeyOf(post.userId, userId),
    createTime: now()
  });

  await pushMessage({
    toUserId: post.userId,
    type: 'claim',
    postId: post._id,
    fromUserId: userId,
    title: '收到一条认领申请',
    content:
      '有人申请认领你发布的「' +
      post.category +
      '」，理由：' +
      message.slice(0, 40) +
      (post.type === 'found' ? '（同意后你可获 ' + POINT_PER_RETURN + ' 积分）' : '')
  });

  return { ok: true, claimId: claim._id, tip: '已提交申请，等待对方确认后即可看到联系方式' };
}

async function acceptClaim(userId, claimId) {
  const claim = await db.get(COLL.claims, claimId);
  if (!claim) return { ok: false, errMsg: '认领申请不存在' };
  const post = await db.get(COLL.posts, claim.postId);
  if (!post) return { ok: false, errMsg: '帖子不存在' };
  if (post.userId !== userId) return { ok: false, errMsg: '只有帖子作者可以同意认领' };
  if (claim.status === 'accepted') {
    return { ok: false, errMsg: '该申请已经同意过了' };
  }

  // 捡到物品的一方：招领帖 → 帖主；失物帖 → 认领人
  const finderId = post.type === 'found' ? post.userId : claim.claimerId;

  let credited = false;
  if (post.pointCredited !== true && claim.credited !== true) {
    const dup = await db.list(
      COLL.claims,
      (c) => c.pairKey === claim.pairKey && c.credited === true && c._id !== claim._id
    );
    if (!dup.length) {
      await addPoints(finderId, POINT_PER_RETURN);
      credited = true;
      await db.update(COLL.claims, claim._id, { credited: true, creditTo: finderId, creditTime: now() });
      if (finderId === userId) {
        await pushMessage({
          toUserId: finderId,
          type: 'point',
          postId: post._id,
          title: '积分到账 +' + POINT_PER_RETURN,
          content: '你捡到的「' + post.category + '」已成功归还，积分 +' + POINT_PER_RETURN + '，可兑换食堂餐券'
        });
      }
    }
  }

  await db.update(COLL.claims, claim._id, { status: 'accepted', updateTime: now() });

  const patch = {
    status: 'claimed',
    claimedBy: claim.claimerId,
    claimedTime: now(),
    updateTime: now()
  };
  if (credited) {
    patch.pointCredited = true;
    patch.pointTo = finderId;
  }
  await db.update(COLL.posts, post._id, patch);

  // 其他待处理申请自动拒绝
  const others = await db.list(
    COLL.claims,
    (c) => c.postId === post._id && c.status === 'pending' && c._id !== claim._id
  );
  for (const o of others) {
    await db.update(COLL.claims, o._id, { status: 'rejected', updateTime: now() });
  }

  await pushMessage({
    toUserId: claim.claimerId,
    type: 'claim',
    postId: post._id,
    fromUserId: userId,
    title: '认领申请已通过',
    content: '对方已同意你的认领，联系方式已解锁，请尽快联系完成交接'
  });
  await markReadByPost(post._id, [post.userId, claim.claimerId]);

  const myPoints = await readPoints(userId);
  return {
    ok: true,
    credited,
    creditedTo: credited ? (finderId === userId ? 'me' : 'other') : '',
    myPoints,
    tip: credited
      ? finderId === userId
        ? '已同意，你 +' + POINT_PER_RETURN + ' 积分'
        : '已同意，对方 +' + POINT_PER_RETURN + ' 积分'
      : '已同意，联系方式已解锁'
  };
}

async function rejectClaim(userId, claimId) {
  const claim = await db.get(COLL.claims, claimId);
  if (!claim) return { ok: false, errMsg: '认领申请不存在' };
  const post = await db.get(COLL.posts, claim.postId);
  if (!post || post.userId !== userId) return { ok: false, errMsg: '只有帖子作者可以拒绝认领' };
  if (claim.status !== 'pending') return { ok: false, errMsg: '该申请已处理过' };
  await db.update(COLL.claims, claim._id, { status: 'rejected', updateTime: now() });
  await pushMessage({
    toUserId: claim.claimerId,
    type: 'claim',
    postId: post._id,
    fromUserId: userId,
    title: '认领申请未通过',
    content: '对方暂时没有确认你的认领，你可以补充细节后再次申请'
  });
  await markReadByPost(post._id, [userId]);
  return { ok: true, tip: '已拒绝该申请' };
}

/**
 * 结束信息：招领帖主 +1 积分（同一帖只加一次），失物帖不加分。
 * 这是用户确认过的规则，只有一个「确认结束吗」的弹窗，不弹任何选项。
 */
async function closePost(userId, postId) {
  const post = await db.get(COLL.posts, postId);
  if (!post) return { ok: false, errMsg: '帖子不存在' };
  if (post.userId !== userId) return { ok: false, errMsg: '无权操作他人的帖子' };
  if (post.status !== 'active') return { ok: false, errMsg: '该帖子已结束' };

  let credited = false;
  if (post.type === 'found' && post.pointCredited !== true) {
    await addPoints(userId, POINT_PER_RETURN);
    credited = true;
    await pushMessage({
      toUserId: userId,
      type: 'point',
      postId: post._id,
      title: '积分到账 +' + POINT_PER_RETURN,
      content: '招领帖「' + post.category + '」已结束，归还成功 +' + POINT_PER_RETURN + ' 积分，可兑换食堂餐券'
    });
  }

  const patch = { status: 'closed', updateTime: now() };
  if (credited) {
    patch.pointCredited = true;
    patch.pointTo = userId;
  }
  await db.update(COLL.posts, post._id, patch);

  const pending = await db.list(COLL.claims, (c) => c.postId === postId && c.status === 'pending');
  for (const c of pending) {
    await db.update(COLL.claims, c._id, { status: 'rejected', updateTime: now() });
    await pushMessage({
      toUserId: c.claimerId,
      type: 'claim',
      postId,
      fromUserId: userId,
      title: '帖子已结束',
      content: '对方已结束这条信息，你的申请自动关闭'
    });
  }
  await markReadByPost(postId, [userId]);

  return {
    ok: true,
    credited,
    creditedTo: credited ? 'me' : '',
    myPoints: await readPoints(userId),
    tip: credited ? '已结束，归还成功 +' + POINT_PER_RETURN + ' 积分' : '已结束'
  };
}

/** 积分补发自检（幂等） */
async function repairPoints(userId, dryRun) {
  const claims = await db.list(COLL.claims, (c) => c.status === 'accepted' && (c.ownerId === userId || c.claimerId === userId));
  const posts = await db.list(COLL.posts, (p) => p.userId === userId);
  const postMap = {};
  posts.forEach((p) => (postMap[p._id] = p));

  let scanned = claims.length;
  let willCredit = 0;
  let already = 0;
  let dup = 0;
  let noType = 0;
  const seenPair = {};

  for (const c of claims) {
    if (c.credited === true) {
      already++;
      continue;
    }
    const post = postMap[c.postId] || (await db.get(COLL.posts, c.postId));
    const postType = c.postType || (post && post.type) || '';
    if (!postType) {
      noType++;
      continue;
    }
    if (seenPair[c.pairKey]) {
      dup++;
      continue;
    }
    seenPair[c.pairKey] = true;
    willCredit++;
    if (!dryRun) {
      const finderId = postType === 'found' ? (post ? post.userId : c.ownerId) : c.claimerId;
      await addPoints(finderId, POINT_PER_RETURN);
      await db.update(COLL.claims, c._id, { credited: true, creditTo: finderId, creditTime: now() });
      if (post) await db.update(COLL.posts, post._id, { pointCredited: true, pointTo: finderId });
    }
  }

  // 第二部分：已结束/已认领的招领帖但没计分
  const closedFound = posts.filter(
    (p) => p.type === 'found' && (p.status === 'closed' || p.status === 'claimed') && p.pointCredited !== true
  );
  for (const p of closedFound) {
    if (seenPair['post:' + p._id]) continue;
    willCredit++;
    if (!dryRun) {
      await addPoints(userId, POINT_PER_RETURN);
      await db.update(COLL.posts, p._id, { pointCredited: true, pointTo: userId });
    }
  }

  const myPoints = await readPoints(userId);
  return {
    ok: true,
    dryRun: !!dryRun,
    scanned,
    closedPosts: closedFound.length,
    willCredit,
    already,
    dup,
    noType,
    credited: dryRun ? 0 : willCredit,
    myPoints,
    tip: willCredit
      ? dryRun
        ? '发现 ' + willCredit + ' 笔可能漏发的积分，确认后补发'
        : '已补发 ' + willCredit + ' 积分'
      : '没有发现漏发的积分'
  };
}

/* ---------------- 我的 ---------------- */
async function listMyClaims(userId) {
  const claims = await db.list(COLL.claims, (c) => c.claimerId === userId);
  const posts = await db.all(COLL.posts);
  claims.sort((a, b) => (b.createTime || 0) - (a.createTime || 0));
  return claims.slice(0, 30).map((c) => {
    const p = posts[c.postId];
    return {
      _id: c._id,
      status: c.status,
      message: c.message,
      createTime: c.createTime,
      post: p
        ? { _id: p._id, type: p.type, category: p.category, description: p.description, status: p.status }
        : null
    };
  });
}

async function myCenter(userId) {
  await ensureUser(userId);
  const user = await ensureUser(userId);
  const posts = (await db.list(COLL.posts, (p) => p.userId === userId)).sort(
    (a, b) => (b.createTime || 0) - (a.createTime || 0)
  );
  const coupons = (await db.list(COLL.coupons, (c) => c.userId === userId)).sort(
    (a, b) => (b.createTime || 0) - (a.createTime || 0)
  );
  const pendingIncoming = await db.list(
    COLL.claims,
    (c) => c.ownerId === userId && c.status === 'pending'
  );

  const postList = posts.slice(0, 40).map((p) => {
    const out = sanitize(p, userId, true);
    out.pendingClaims = pendingIncoming.filter((c) => c.postId === p._id).length;
    return out;
  });

  return {
    ok: true,
    user: { userId, nickname: user.nickname, points: Number(user.points) || 0 },
    posts: postList,
    coupons: coupons.map((c) => ({
      _id: c._id,
      code: c.code,
      status: c.status,
      createTime: c.createTime,
      usedTime: c.usedTime || 0
    })),
    unread: await unreadCount(userId),
    stats: {
      postCount: posts.length,
      activeCount: posts.filter((p) => p.status === 'active').length,
      returnedCount: posts.filter((p) => p.pointCredited === true).length
    },
    couponCost: COUPON_COST
  };
}

/* ---------------- 奖励 / 餐券 ---------------- */
async function redeemCoupon(userId) {
  const points = await readPoints(userId);
  if (points < COUPON_COST) {
    return { ok: false, errMsg: '积分不足，还差 ' + (COUPON_COST - points) + ' 分' };
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayCount = (await db.list(COLL.coupons, (c) => c.userId === userId && c.createTime >= today.getTime()))
    .length;
  if (todayCount >= COUPON_DAILY_LIMIT) {
    return { ok: false, errMsg: '每天最多兑换 ' + COUPON_DAILY_LIMIT + ' 张，明天再来吧' };
  }
  await addPoints(userId, -COUPON_COST);
  const coupon = await db.insert(COLL.coupons, {
    userId,
    code: genCouponCode(),
    status: 'valid',
    createTime: now()
  });
  return {
    ok: true,
    coupon: { _id: coupon._id, code: coupon.code, status: coupon.status, createTime: coupon.createTime },
    myPoints: await readPoints(userId),
    tip: '兑换成功，凭核销码到食堂使用'
  };
}

async function grantPoints(userId, points) {
  const delta = Number(points) || 0;
  if (delta <= 0) return { ok: false, errMsg: 'points 必须为正数' };
  if (delta > 10) return { ok: false, errMsg: '单次最多加 10 分' };
  await ensureUser(userId);
  const next = await addPoints(userId, delta);
  return { ok: true, myPoints: next, tip: '已加 ' + delta + ' 分（演示用）' };
}

/* ---------------- 演示数据 ---------------- */
function daysAgo(n, hour) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  if (typeof hour === 'number') d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

const DEMO_ROWS = [
  { type: 'lost', category: '校园卡/一卡通', color: '黑色', brand: '', campus: '将军路校区', building: '图书馆', d: 1, desc: '丢失一张校园卡，姓名张三，蓝色卡套，背面贴了一张柯基贴纸', idNumber: '320106200301011234' },
  { type: 'found', category: '校园卡/一卡通', color: '黑色', brand: '', campus: '将军路校区', building: '图书馆', d: 0, desc: '捡到一张校园卡，姓名张三，蓝色卡套' },
  { type: 'lost', category: '水杯', color: '白色', brand: '膳魔师', campus: '将军路校区', building: '西区教学楼', d: 2, desc: '丢失一个白色保温杯，杯盖边缘有磕碰痕迹，杯身贴着名字标签' },
  { type: 'found', category: '水杯', color: '白色', brand: '膳魔师', campus: '将军路校区', building: '西区教学楼', d: 1, desc: '捡到一个白色保温杯，杯盖有磕碰痕迹' },
  { type: 'lost', category: '钥匙', color: '灰色/银色', brand: '', campus: '将军路校区', building: '东区教学楼', d: 3, desc: '丢了一串钥匙三把，带蓝色挂饰，有一把是宿舍钥匙' },
  { type: 'found', category: '手机', color: '黑色', brand: 'iPhone', campus: '将军路校区', building: '一食堂', d: 1, desc: '捡到一部黑色手机，透明壳，屏保是小猫' },
  { type: 'lost', category: '手机', color: '黑色', brand: 'iPhone', campus: '将军路校区', building: '图书馆', d: 2, desc: '丢失一部黑色手机，套着透明手机壳' },
  { type: 'found', category: '耳机', color: '白色', brand: 'AirPods', campus: '将军路校区', building: '图书馆', d: 2, desc: '捡到白色无线耳机，充电盒有划痕' },
  { type: 'lost', category: '耳机', color: '白色', brand: 'AirPods', campus: '将军路校区', building: '图书馆', d: 3, desc: '丢失白色蓝牙耳机，充电盒盖上有明显划痕' },
  { type: 'found', category: '充电宝/充电器', color: '白色', brand: '小米', campus: '将军路校区', building: '教学楼', d: 4, desc: '捡到一个白色充电宝，小米的，上面有贴纸' },
  { type: 'lost', category: '充电宝/充电器', color: '白色', brand: '小米', campus: '将军路校区', building: '教学楼', d: 4, desc: '丢失白色小米充电宝，10000毫安，表面有贴纸' },
  { type: 'found', category: '身份证', color: '不确定/不适用', brand: '', campus: '将军路校区', building: '大西门', d: 5, desc: '捡到一张身份证，姓名李四', idNumber: '320106200305054321' },
  { type: 'lost', category: '身份证', color: '不确定/不适用', brand: '', campus: '将军路校区', building: '大西门', d: 6, desc: '丢失一张身份证，姓名李四，补办很急' },
  { type: 'found', category: '雨伞', color: '蓝色', brand: '', campus: '将军路校区', building: '一号楼（主楼）', d: 2, desc: '捡到一把蓝色折叠伞，伞柄是弯的' },
  { type: 'lost', category: '雨伞', color: '蓝色', brand: '', campus: '将军路校区', building: '一号楼（主楼）', d: 2, desc: '丢失一把蓝色折叠伞，伞柄是弯钩形的' },
  { type: 'found', category: '书本/笔记', color: '蓝色', brand: '', campus: '明故宫校区', building: '图书馆', d: 3, desc: '捡到一本高等数学课本，封面上写了名字' },
  { type: 'lost', category: '书本/笔记', color: '蓝色', brand: '', campus: '将军路校区', building: '图书馆', d: 3, desc: '丢失一本高等数学课本，封面上写了名字' },
  { type: 'found', category: '电脑/平板', color: '灰色/银色', brand: 'iPad', campus: '将军路校区', building: '计算中心', d: 1, desc: '捡到一个灰色平板电脑，屏幕右下角有裂痕' },
  { type: 'lost', category: '背包/袋子', color: '黑色', brand: '', campus: '将军路校区', building: '一食堂（桃李苑）', d: 5, desc: '丢失黑色双肩包，里面有两本书和一个水杯' },
  { type: 'found', category: '眼镜', color: '黑色', brand: '', campus: '将军路校区', building: '体育馆', d: 6, desc: '捡到一副眼镜，黑色镜框，装在灰色眼镜盒里' }
];

async function seedDemo(userId, force) {
  const existing = await db.list(COLL.posts, (p) => p.demo === true);
  if (existing.length && !force) {
    return { ok: true, seeded: 0, msg: '演示数据已存在（' + existing.length + ' 条）', already: true };
  }
  if (existing.length && force) {
    const msgs = await db.list(COLL.messages, (m) => m.demo === true);
    const claims = await db.list(COLL.claims, (c) => c.demo === true);
    const ids = existing.concat(msgs, claims).map((x) => x._id);
    const store = require('./store');
    await store.removeMany(COLL.posts, existing.map((x) => x._id));
    await store.removeMany(COLL.messages, msgs.map((x) => x._id));
    await store.removeMany(COLL.claims, claims.map((x) => x._id));
    console.log('[seed] 已清除旧演示数据 ' + ids.length + ' 条');
  }

  await ensureUser(userId);
  const others = ['demo_002', 'demo_003', 'demo_004', 'demo_005', 'demo_011'];
  for (const o of others) await ensureUser(o);

  const created = [];
  let idx = 0;
  for (const row of DEMO_ROWS) {
    // 每 4 条里安排 1 条属于当前用户，保证「我的」页面有内容
    const mine = idx % 5 === 0;
    const owner = mine ? userId : others[idx % others.length];
    const t = daysAgo(row.d, 9 + (idx % 8));
    const post = {
      type: row.type,
      category: row.category,
      color: row.color,
      brand: row.brand,
      locations: [{ campus: row.campus, building: row.building }],
      campus: row.campus,
      building: row.building,
      eventTime: t,
      eventTimeEnd: 0,
      timeUnknown: false,
      timeMode: 'day',
      description: row.desc,
      contact: { wechat: mine ? 'demo_wx' : 'demo_' + (idx + 10), phone: '1380000' + String(1000 + idx) },
      images: [],
      status: 'active',
      userId: owner,
      demo: true,
      createTime: t,
      updateTime: t
    };
    if (row.idNumber) {
      post.sensitive = { idNumber: row.idNumber };
      post.idTail = '****' + row.idNumber.slice(-4);
    }
    post._id = 'demo_p' + String(idx + 1).padStart(2, '0');
    created.push(post);
    idx++;
  }
  await require('./store').saveMany(COLL.posts, created);

  // 给当前用户挂一条待处理认领申请（挂在「我」的招领帖上，方便演示 +1 积分）
  const myFound = created.find((p) => p.userId === userId && p.type === 'found');
  if (myFound) {
    await db.insert(COLL.claims, {
      _id: 'demo_claim_1',
      postId: myFound._id,
      ownerId: userId,
      claimerId: 'demo_002',
      message: '这是我丢的' + myFound.category + '，' + String(myFound.description).slice(0, 22) + '，细节都对得上',
      claimerContact: { wechat: 'demo_lisi', phone: '13900000002' },
      status: 'pending',
      postType: 'found',
      postCategory: myFound.category,
      pairKey: pairKeyOf(userId, 'demo_002'),
      demo: true,
      createTime: daysAgo(0, 10)
    });
    await pushMessage({
      toUserId: userId,
      type: 'claim',
      postId: myFound._id,
      fromUserId: 'demo_002',
      title: '收到一条认领申请',
      content: '有人申请认领你捡到的「' + myFound.category + '」（同意后你可获 1 积分）',
      demo: true
    });
  }

  // 一条匹配提醒，展示打分效果
  const lostCard = created.find((p) => p.type === 'lost' && p.category === '校园卡/一卡通');
  const foundCard = created.find((p) => p.type === 'found' && p.category === '校园卡/一卡通' && p.userId !== lostCard.userId);
  if (lostCard && foundCard) {
    const r = computeMatchScore(lostCard, foundCard);
    await pushMessage({
      toUserId: lostCard.userId,
      type: 'match',
      postId: foundCard._id,
      matchPostId: lostCard._id,
      fromUserId: foundCard.userId,
      title: '有人捡到了：校园卡/一卡通',
      content: '有人发布了招领信息，和你的失物帖匹配度 ' + r.score + ' 分',
      score: r.score,
      reasons: r.reasons,
      demo: true
    });
  }

  // 初始积分与券
  await db.update(COLL.users, userId, { points: 3, updateTime: now() });
  await require('./store').saveMany(COLL.coupons, [
    { _id: 'demo_c1', userId, code: 'K7M2QP9X', status: 'valid', demo: true, createTime: daysAgo(2, 12) },
    { _id: 'demo_c2', userId, code: 'R4T8WN3B', status: 'valid', demo: true, createTime: daysAgo(1, 12) }
  ]);

  return { ok: true, seeded: created.length, myFoundPostId: myFound ? myFound._id : '', msg: '已导入 ' + created.length + ' 条演示数据' };
}

/** 清空演示数据（重复导入时用） */
async function clearDemo(userId) {
  const store = require('./store');
  const posts = await db.list(COLL.posts, (p) => p.demo === true);
  const msgs = await db.list(COLL.messages, (m) => m.demo === true);
  const claims = await db.list(COLL.claims, (c) => c.demo === true);
  await store.removeMany(COLL.posts, posts.map((x) => x._id));
  await store.removeMany(COLL.messages, msgs.map((x) => x._id));
  await store.removeMany(COLL.claims, claims.map((x) => x._id));
  return {
    ok: true,
    removed: { posts: posts.length, messages: msgs.length, claims: claims.length },
    msg: '已清除演示数据：帖子 ' + posts.length + ' / 消息 ' + msgs.length + ' / 申请 ' + claims.length
  };
}

/** 去重（同类型 + 同类目 + 同描述 + 同分钟视为重复，保留最早一条） */
async function dedupe(userId, dryRun) {
  const posts = (await db.list(COLL.posts)).sort((a, b) => (a.createTime || 0) - (b.createTime || 0));
  const seen = {};
  const dupIds = [];
  posts.forEach((p) => {
    const k = [p.type, p.category, p.description, Math.floor((p.createTime || 0) / 60000)].join('|');
    if (seen[k]) dupIds.push(p._id);
    else seen[k] = true;
  });
  if (!dryRun && dupIds.length) {
    await require('./store').removeMany(COLL.posts, dupIds);
  }
  return { ok: true, dryRun: !!dryRun, total: posts.length, removable: dupIds.length, ids: dupIds.slice(0, 20) };
}

module.exports = {
  ensureUser,
  addPoints,
  readPoints,
  pushMessage,
  unreadCount,
  listMessages,
  markReadByPost,
  markAllRead,
  publishPost,
  listPosts,
  getPostDetail,
  searchPosts,
  createClaim,
  acceptClaim,
  rejectClaim,
  closePost,
  repairPoints,
  listMyClaims,
  myCenter,
  redeemCoupon,
  grantPoints,
  seedDemo,
  clearDemo,
  dedupe,
  levelOf
};
