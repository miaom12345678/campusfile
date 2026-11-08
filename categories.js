/**
 * 站点配置：物品类别、颜色、校区与楼栋、时间范围、积分规则
 * ------------------------------------------------
 * 已按南京航空航天大学的实际情况配置。
 *   1. CAMPUS_LOCATIONS —— 校区 / 楼栋两级地点（楼栋按教学区、宿舍区、食堂、其他分组）
 *      楼栋名如有出入（尤其是天目湖校区），直接改这里即可，不需要动任何逻辑代码。
 *   2. 发帖时地点可多选（最多 MAX_LOCATION 个），匹配时取最优地点打分，不叠加。
 */

// 物品类别
const CATEGORIES = [
  '校园卡/一卡通',
  '身份证',
  '学生证/证件',
  '手机',
  '耳机',
  '充电宝/充电器',
  '电脑/平板',
  '钥匙',
  '钱包/卡包',
  '水杯',
  '雨伞',
  '书本/笔记',
  '背包/袋子',
  '眼镜',
  '手表',
  '衣物',
  '运动器材',
  '洗漱/化妆品',
  '其他'
];

// 颜色（选填：身份证、证件这类物品本来就没有颜色，可以不选）
const COLORS = [
  '不确定/不适用',
  '黑色',
  '白色',
  '灰色/银色',
  '金色/香槟',
  '蓝色',
  '红色',
  '绿色',
  '黄色/橙色',
  '粉色',
  '紫色',
  '棕色/卡其',
  '透明',
  '花色/多色'
];

// 视为「没有颜色信息」的选项：不参与打分，也不会因为对不上而扣分
const COLOR_UNKNOWN = '不确定/不适用';

/**
 * 需要填写号码的证件类物品
 * 完整号码只存在服务端用于匹配，帖子上一律只显示后四位
 */
const ID_CATEGORIES = ['身份证', '学生证/证件', '校园卡/一卡通'];

/** 判断某个类别是否需要填证件号 */
function needIdNumber(category) {
  return ID_CATEGORIES.indexOf(category) >= 0;
}

/**
 * 校区 → 楼栋（两级地点，楼栋按用途分组，方便发布时勾选）
 * 结构：{ name: 校区名, groups: [{ label: 分组名, buildings: [...] }] }
 */
const CAMPUS_LOCATIONS = [
  {
    name: '将军路校区',
    groups: [
      {
        label: '教学区',
        buildings: ['一号楼（主楼）', '东区教学楼', '西区教学楼', '图书馆', '计算中心', '音乐厅']
      },
      {
        label: '宿舍区',
        buildings: ['慧园1-5栋', '博园6-15栋', '怡园16-22栋', '馨园33-34栋', '和园35-37栋']
      },
      {
        label: '食堂',
        buildings: ['一食堂', '二食堂', '三食堂', '四食堂', '五食堂（飞行员食堂）', '东清食堂', '和园餐厅']
      },
      {
        label: '运动与其他',
        buildings: ['体育馆', '游泳馆', '东操场', '慧园足球场', '砚湖', '大西门', '菜鸟驿站', '校医院']
      }
    ]
  },
  {
    name: '明故宫校区',
    groups: [
      { label: '教学区', buildings: ['图书馆', '荟萃楼', '教学楼', '计算中心'] },
      { label: '宿舍区', buildings: ['B区宿舍（B1-B8）', 'B区宿舍（B9-B15）', 'B区宿舍（B16-B20）'] },
      { label: '食堂与其他', buildings: ['一食堂（桃李苑）', '二食堂（清真）', '体育馆', '田径场', '东门', '西华门'] }
    ]
  },
  {
    name: '天目湖校区',
    groups: [
      { label: '教学区', buildings: ['教学楼', '图书馆', '实验楼'] },
      { label: '生活区', buildings: ['食堂', '宿舍区', '体育馆', '操场'] }
    ]
  },
  {
    name: '校外/周边',
    groups: [
      { label: '校外', buildings: ['校门外商铺', '公交站', '地铁站', '翠屏山', '托乐嘉', '其他'] }
    ]
  }
];

// 单次发帖最多可选择的地点数量
const MAX_LOCATION = 3;

// 时间范围（发布页快捷按钮）
const TIME_RANGES = ['今天', '昨天', '近三天', '近一周', '近半个月', '近一个月', '更早'];

// 时间粒度：精确到一天，或给一个区间（如"国庆前后那几天记不清了"）
const TIME_MODES = [
  { key: 'day', label: '具体某一天' },
  { key: 'range', label: '一个时间段' },
  { key: 'unknown', label: '记不清了' }
];

// 帖子类型
const POST_TYPES = [
  { key: 'lost', label: '我丢了东西', desc: '发布失物信息，等待捡到的人来匹配' },
  { key: 'found', label: '我捡到东西', desc: '发布招领信息，等待失主来匹配' }
];

// 帖子状态
const POST_STATUS = {
  ACTIVE: 'active',       // 进行中，参与搜索与匹配
  CLAIMED: 'claimed',     // 已认领，双方已确认
  CLOSED: 'closed'        // 已关闭，不参与搜索与匹配
};

const STATUS_LABEL = {
  active: '进行中',
  claimed: '已认领',
  closed: '已关闭'
};

// 积分规则：成功归还一次，捡到东西的一方 +1 分；每 COUPON_COST 分兑换一张餐券
const POINT_PER_RETURN = 1;
const COUPON_COST = 2;

/** 取某校区的全部楼栋（扁平数组） */
function getBuildings(campusIndex) {
  const campus = CAMPUS_LOCATIONS[campusIndex];
  if (!campus) return [];
  const list = [];
  campus.groups.forEach((g) => {
    g.buildings.forEach((b) => list.push(b));
  });
  return list;
}

/** 取某校区的分组结构（供发布页分组展示） */
function getGroups(campusIndex) {
  const campus = CAMPUS_LOCATIONS[campusIndex];
  return campus ? campus.groups : [];
}

module.exports = {
  CATEGORIES,
  COLORS,
  COLOR_UNKNOWN,
  ID_CATEGORIES,
  needIdNumber,
  CAMPUS_LOCATIONS,
  MAX_LOCATION,
  TIME_RANGES,
  TIME_MODES,
  POST_TYPES,
  POST_STATUS,
  STATUS_LABEL,
  POINT_PER_RETURN,
  COUPON_COST,
  getBuildings,
  getGroups
};
