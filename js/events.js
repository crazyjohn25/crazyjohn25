/**
 * 宏观事件模块
 * 1. 内置一批重要宏观事件（美联储议息、地缘局势、油价冲击等）作为示例数据；
 * 2. 支持用户在页面上添加自定义事件，持久化到 localStorage；
 * 3. 预留 fetchLiveEvents 钩子，可接入任意财经日历/新闻 API 做实时收集。
 *
 * 事件结构: { id, time(秒级时间戳), title, category, impact('high'|'medium'|'low'), note }
 */

const STORAGE_KEY = 'kchart.customEvents.v1';

export const EVENT_CATEGORIES = {
  fed: { label: '美联储/货币政策', color: '#e6b800' },
  geo: { label: '地缘政治', color: '#e05252' },
  oil: { label: '石油/大宗商品', color: '#4d94ff' },
  sector: { label: '细分赛道', color: '#9966ff' },
  breaking: { label: '突发行情', color: '#ff7f2a' },
  other: { label: '其他', color: '#8a8a8a' },
};

/** 内置示例宏观事件（UTC 秒级时间戳） */
export const BUILTIN_EVENTS = [
  {
    id: 'b1',
    time: Date.UTC(2025, 0, 29, 19, 0) / 1000,
    title: '美联储FOMC决议：维持利率不变',
    category: 'fed',
    impact: 'high',
    note: '联邦基金利率维持4.25%-4.50%，鲍威尔称通胀仍偏高',
  },
  {
    id: 'b2',
    time: Date.UTC(2025, 2, 19, 18, 0) / 1000,
    title: '美联储3月议息：点阵图暗示年内两次降息',
    category: 'fed',
    impact: 'high',
    note: '风险资产短线拉升',
  },
  {
    id: 'b3',
    time: Date.UTC(2025, 5, 13, 4, 0) / 1000,
    title: '中东局势升级：伊朗核设施遇袭',
    category: 'geo',
    impact: 'high',
    note: '原油、黄金跳涨，风险资产急跌',
  },
  {
    id: 'b4',
    time: Date.UTC(2025, 5, 23, 12, 0) / 1000,
    title: '霍尔木兹海峡通行受威胁，布油突破80美元',
    category: 'oil',
    impact: 'high',
    note: '能源板块领涨，运输成本预期上升',
  },
  {
    id: 'b5',
    time: Date.UTC(2025, 8, 17, 18, 0) / 1000,
    title: '美联储降息25bp',
    category: 'fed',
    impact: 'high',
    note: '首次降息落地，美元指数走弱',
  },
  {
    id: 'b6',
    time: Date.UTC(2025, 10, 5, 8, 0) / 1000,
    title: 'AI算力赛道：头部云厂商上调资本开支指引',
    category: 'sector',
    impact: 'medium',
    note: '算力/电力细分赛道走强',
  },
];

/** 读取用户自定义事件 */
export function loadCustomEvents() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

/** 保存用户自定义事件 */
export function saveCustomEvents(events) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
}

/** 添加一条自定义事件并持久化，返回新事件 */
export function addCustomEvent({ time, title, category = 'other', impact = 'medium', note = '' }) {
  const events = loadCustomEvents();
  const evt = {
    id: `c${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    time,
    title,
    category: EVENT_CATEGORIES[category] ? category : 'other',
    impact,
    note,
  };
  events.push(evt);
  saveCustomEvents(events);
  return evt;
}

/** 删除自定义事件 */
export function removeCustomEvent(id) {
  const events = loadCustomEvents().filter((e) => e.id !== id);
  saveCustomEvents(events);
}

/**
 * 实时事件采集钩子。
 * 默认返回空数组；接入实际数据源时，把返回值映射为标准事件结构即可，例如：
 *   - 财经日历类: investing.com / 金十数据 / TradingEconomics API
 *   - 新闻快讯类: NewsAPI / 自建爬虫服务
 * @param {string} apiUrl 可选，自定义JSON接口，需返回 [{time,title,category,impact,note}]
 */
export async function fetchLiveEvents(apiUrl) {
  if (!apiUrl) return [];
  try {
    const res = await fetch(apiUrl);
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter((e) => e && typeof e.time === 'number' && e.title)
      .map((e, idx) => ({
        id: `live_${e.time}_${idx}`,
        time: e.time,
        title: String(e.title),
        category: EVENT_CATEGORIES[e.category] ? e.category : 'other',
        impact: ['high', 'medium', 'low'].includes(e.impact) ? e.impact : 'medium',
        note: e.note ? String(e.note) : '',
      }));
  } catch (_) {
    return [];
  }
}

/** 合并所有来源的事件并按时间排序 */
export function getAllEvents(liveEvents = []) {
  return [...BUILTIN_EVENTS, ...loadCustomEvents(), ...liveEvents].sort(
    (a, b) => a.time - b.time
  );
}
