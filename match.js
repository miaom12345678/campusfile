/**
 * 匹配打分引擎
 * ------------------------------------------------
 * 只在「失物帖(lost)」与「招领帖(found)」之间交叉计算，两个同为 lost 的帖子永不匹配。
 *
 * 满分为 100，各维度权重：
 *   物品类别 30 + 颜色 15 + 地点 20 + 时间 15 + 描述关键词 20
 *
 * 加分规则：
 *   - 类别不同 → 整条分数打五折（视为强不匹配信号，几乎不可能超过推送阈值）
 *   - 只有总分 >= MATCH_THRESHOLD(60) 才会写入对方的消息中心
 */

const MATCH_THRESHOLD = 60;

const WEIGHT = {
  category: 30,
  color: 15,
  location: 20,
  time: 15,
  keyword: 20
};

/**
 * 惩罚系数：用于压制「某一维度完全对不上」的高分
 *   categoryMismatch —— 类别不同，整条打五折
 *   campusMismatch   —— 跨校区，打八折（特征完全一致时仍可能推送，但门槛更高）
 *   timeMismatch     —— 时间完全对不上（相差 90 天以上，或捡到时间早于丢失时间 7 天以上），打六折
 * 想放宽或收紧推送，改这里即可；阈值见 MATCH_THRESHOLD。
 */
const PENALTY = {
  categoryMismatch: 0.5,
  campusMismatch: 0.8,
  timeMismatch: 0.6,
  // 双方都填了证件号但后四位对不上 —— 几乎可以确定不是同一件东西
  idMismatch: 0.6
};

// 证件号完全一致时的额外加分（属于"铁证"，直接把分数顶上去）
const ID_EXACT_BONUS = 25;
const ID_TAIL_BONUS = 8;
// 颜色里的"不确定/不适用"与旧版的"不清楚"等价
const COLOR_UNKNOWN = '不确定/不适用';
const COLOR_UNKNOWN_OLD = '不清楚';

const DAY = 24 * 60 * 60 * 1000;

/** 去掉标点与空白，只保留中英文数字，用于关键词比对 */
function normalize(text) {
  if (!text) return '';
  return String(text)
    .replace(/[\s\r\n]+/g, '')
    .replace(/[，。！？、；：“”‘’（）()【】\[\]《》,.!?;:'"_\-—+*#~`|/\\]/g, '')
    .toLowerCase();
}

/** 生成二元组（bigram）集合：中文没有空格分词，用 2-gram 做近似关键词匹配 */
function bigrams(text) {
  const s = normalize(text);
  const set = {};
  let count = 0;
  if (s.length === 1) {
    set[s] = true;
    return { set, count: 1 };
  }
  for (let i = 0; i < s.length - 1; i++) {
    set[s.slice(i, i + 2)] = true;
    count++;
  }
  return { set, count };
}

/** Dice 系数：2 * 交集 / (A + B)，比 Jaccard 更偏好短文本重合 */
function diceCoefficient(textA, textB) {
  const a = bigrams(textA);
  const b = bigrams(textB);
  if (!a.count || !b.count) return 0;
  let inter = 0;
  for (const k in a.set) {
    if (b.set[k]) inter++;
  }
  return (2 * inter) / (a.count + b.count);
}

/** 取出帖子的地点列表：优先用多选的 locations，兼容只有单地点的旧数据 */
function getLocations(post) {
  if (post.locations && post.locations.length) {
    return post.locations.filter((l) => l && l.campus);
  }
  if (post.campus) {
    return [{ campus: post.campus, building: post.building || '' }];
  }
  return [];
}

/**
 * 地点得分：帖子可以选多个地点，这里取「两帖地点两两比对的最高分」，
 * 而不是累加——否则多选地点就能轻松刷高分数。
 *   同校区同楼栋 20 分 / 同校区不同楼栋 12 分 / 完全跨校区 0 分
 */
function scoreLocation(a, b) {
  const la = getLocations(a);
  const lb = getLocations(b);
  if (!la.length || !lb.length) {
    return { score: 0, campusSame: false, buildingSame: false, known: false };
  }
  let best = 0;
  let campusSame = false;
  let buildingSame = false;
  let bestCampus = '';
  let bestBuilding = '';
  for (const x of la) {
    for (const y of lb) {
      if (!x.campus || !y.campus || x.campus !== y.campus) continue;
      campusSame = true;
      const sameBuilding = !!(x.building && y.building && x.building === y.building);
      const s = sameBuilding ? WEIGHT.location : 12;
      if (s > best) {
        best = s;
        bestCampus = x.campus;
        bestBuilding = x.building || '';
        buildingSame = sameBuilding;
      }
    }
  }
  return {
    score: best,
    campusSame,
    buildingSame,
    known: true,
    campus: bestCampus,
    building: bestBuilding
  };
}

/**
 * 时间得分：捡到的时间应当晚于（或接近）丢失的时间
 * diff = 捡到时间 - 丢失时间
 * 支持三种填法：具体某一天 / 一个时间段（eventTime ~ eventTimeEnd）/ 记不清（timeUnknown）
 */
function scoreTime(a, b) {
  // a / b 中，lost 帖是丢失时间，found 帖是捡到时间
  const lost = a.type === 'lost' ? a : b;
  const found = a.type === 'found' ? a : b;

  // 任一方「记不清」：视为未知，不得分也不惩罚
  if (lost.timeUnknown || found.timeUnknown) {
    return { score: 0, mismatch: false, known: false };
  }

  const lt = Number(lost.eventTime) || 0;
  const ltEnd = Number(lost.eventTimeEnd) || 0;
  const ft = Number(found.eventTime) || 0;
  // 有一方没填时间：视为未知，不得分也不惩罚
  if (!lt || !ft) return { score: 0, mismatch: false, known: false };

  // 丢失时间是一个区间，且捡到时间落在区间内（或紧邻区间）——最理想的情况
  if (ltEnd && ft >= lt - 1 * DAY && ft <= ltEnd + 1 * DAY) {
    return { score: WEIGHT.time, mismatch: false, known: true, inRange: true };
  }

  // 有区间时按「离区间最近的一端」算差距；没有区间就按单日算
  let diff;
  if (ltEnd && ft > ltEnd) diff = ft - ltEnd;
  else diff = ft - lt;

  if (diff >= 0) {
    if (diff <= 1 * DAY) return { score: WEIGHT.time, mismatch: false, known: true };
    if (diff <= 3 * DAY) return { score: 13, mismatch: false, known: true };
    if (diff <= 7 * DAY) return { score: 10, mismatch: false, known: true };
    if (diff <= 30 * DAY) return { score: 6, mismatch: false, known: true };
    if (diff <= 90 * DAY) return { score: 3, mismatch: false, known: true };
    // 相差三个月以上，时间上几乎不可能有关联
    return { score: 0, mismatch: true, known: true };
  }
  // 捡到时间早于丢失时间：多半是记错了日期，给低分但不完全否定
  const gap = -diff;
  if (gap <= 1 * DAY) return { score: 10, mismatch: false, known: true };
  if (gap <= 7 * DAY) return { score: 4, mismatch: false, known: true };
  // 东西还没丢就被捡到了，逻辑不成立
  return { score: 0, mismatch: true, known: true };
}

function scoreCategory(a, b) {
  if (!a.category || !b.category) return { score: 0, same: false };
  const same = a.category === b.category;
  return { score: same ? WEIGHT.category : 0, same };
}

function scoreColor(a, b) {
  // 「不确定/不适用」（以及旧数据的「不清楚」）视为没有颜色信息：不计分也不惩罚
  if (!a.color || !b.color) return 0;
  if (a.color === COLOR_UNKNOWN || b.color === COLOR_UNKNOWN) return 0;
  if (a.color === COLOR_UNKNOWN_OLD || b.color === COLOR_UNKNOWN_OLD) return 0;
  return a.color === b.color ? WEIGHT.color : 0;
}

/** 证件号归一化：只保留数字与字母，忽略空格和横线 */
function normalizeId(raw) {
  return String(raw || '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
}

/**
 * 证件号比对（身份证 / 学生证 / 校园卡的号码）
 * 完整号码只存在于服务端，页面上一律只展示后四位，但这里可以用完整号码做精确比对。
 *   完全一致  → +25（铁证，直接顶到高分）
 *   后四位一致 → +8
 *   后四位不同 → 触发 idMismatch 惩罚（0.6），几乎不可能是同一件东西
 */
function scoreIdNumber(a, b) {
  const ia = normalizeId((a.sensitive && a.sensitive.idNumber) || a.idNumber || '');
  const ib = normalizeId((b.sensitive && b.sensitive.idNumber) || b.idNumber || '');
  if (!ia || !ib || ia.length < 4 || ib.length < 4) {
    return { score: 0, exact: false, tail: false, mismatched: false, known: false };
  }
  if (ia === ib) return { score: ID_EXACT_BONUS, exact: true, tail: true, mismatched: false, known: true };
  if (ia.slice(-4) === ib.slice(-4)) {
    return { score: ID_TAIL_BONUS, exact: false, tail: true, mismatched: false, known: true };
  }
  return { score: 0, exact: false, tail: false, mismatched: true, known: true };
}

function scoreKeyword(a, b) {
  // 品牌 + 特征描述 一起参与关键词比对
  const ta = [a.brand || '', a.description || ''].join(' ');
  const tb = [b.brand || '', b.description || ''].join(' ');
  const dice = diceCoefficient(ta, tb);
  return Math.round(dice * WEIGHT.keyword);
}

/** 把文本里的特征词提取成「命中关键词」，用于给用户展示匹配理由 */
function commonKeywords(a, b) {
  const ta = [a.brand || '', a.description || ''].join(' ');
  const tb = [b.brand || '', b.description || ''].join(' ');
  const ga = bigrams(ta).set;
  const gb = bigrams(tb).set;
  const hits = [];
  for (const k in ga) {
    if (gb[k]) hits.push(k);
  }
  // 相邻的两个 bigram 合并成一个更长的词，展示效果更好
  const merged = [];
  let buf = '';
  hits.sort();
  for (let i = 0; i < hits.length; i++) {
    if (buf && buf.slice(-1) === hits[i][0]) {
      buf += hits[i][1];
    } else {
      if (buf) merged.push(buf);
      buf = hits[i];
    }
  }
  if (buf) merged.push(buf);
  return merged.filter((w) => w.length >= 2).slice(0, 5);
}

/**
 * 计算两帖的匹配度
 * @returns {{score:number, hit:boolean, reasons:string[], details:object}}
 */
function computeMatchScore(a, b) {
  if (!a || !b) return { score: 0, hit: false, reasons: [], details: {} };
  // 只做交叉匹配：lost <-> found
  if (a.type === b.type) {
    return { score: 0, hit: false, reasons: [], details: { cross: false } };
  }

  const category = scoreCategory(a, b);
  const color = scoreColor(a, b);
  const loc = scoreLocation(a, b);
  const time = scoreTime(a, b);
  const keyword = scoreKeyword(a, b);
  const idn = scoreIdNumber(a, b);

  let total = category.score + color + loc.score + time.score + keyword + idn.score;
  // 各维度的惩罚可叠加，用于压制「某一项完全对不上」的虚高分
  if (!category.same) total *= PENALTY.categoryMismatch;
  if (loc.known && !loc.campusSame) total *= PENALTY.campusMismatch;
  if (time.mismatch) total *= PENALTY.timeMismatch;
  if (idn.mismatched) total *= PENALTY.idMismatch;
  total = Math.round(total);
  if (total > 100) total = 100;

  const reasons = [];
  if (category.same) reasons.push('同类别：' + a.category);
  if (color === WEIGHT.color) reasons.push('同颜色：' + a.color);
  if (loc.buildingSame) reasons.push('同地点：' + loc.campus + '·' + loc.building);
  else if (loc.campusSame) reasons.push('同校区：' + loc.campus);
  if (time.inRange) reasons.push('捡到时间落在你填写的时间段内');
  else if (time.score >= 10) reasons.push('时间吻合');
  const words = commonKeywords(a, b);
  if (keyword >= 6 && words.length) reasons.push('描述相似：' + words.join('、'));
  if (idn.exact) reasons.push('证件号码完全一致');
  else if (idn.tail) reasons.push('证件号后四位一致');

  return {
    score: total,
    hit: total >= MATCH_THRESHOLD,
    reasons,
    details: {
      category: category.score,
      color,
      location: loc.score,
      time: time.score,
      keyword,
      idNumber: idn.score,
      cross: true,
      penalties: {
        category: !category.same,
        campus: loc.known && !loc.campusSame,
        time: time.mismatch,
        id: idn.mismatched
      }
    }
  };
}

module.exports = {
  MATCH_THRESHOLD,
  WEIGHT,
  PENALTY,
  computeMatchScore,
  diceCoefficient,
  normalize
};
