/**
 * 页面主逻辑：图表渲染、实时数据、指标叠加、事件标注、信号报警、
 * 综合建议、异常交易监控、每小时交易量对比
 */
import { computeAll } from './indicators.js';
import { generateSignals, AlertManager } from './signals.js';
import {
  EVENT_CATEGORIES,
  getAllEvents,
  addCustomEvent,
  removeCustomEvent,
} from './events.js';
import {
  SYMBOLS,
  getSymbol,
  fetchHistory,
  subscribeKline,
  subscribeWhaleTrades,
  generateMockHistory,
  subscribeMockKline,
} from './datafeed.js';
import { hourlyVolumeStats, rolling24hVolume, formatVolume } from './volume.js';
import { detectCandleAnomalies, WhaleFeed } from './anomaly.js';
import { fetchNews } from './news.js';
import { runAdvisor, STRATEGIES } from './advisor.js';
import { PaperWallet } from './wallet.js';
import {
  currentWindowStart,
  fetchWindowMarket,
  fetchBook,
  fetchRealPrices,
  fetchTrades,
  analyzeBook,
  analyzeTrades,
  advise5m,
} from './polymarket.js';
import { ReviewLog } from './review.js';
import { interpret } from './interpret.js';
import {
  SERENITY_PICKS,
  INDUSTRIES,
  NARRATIVES,
  SERENITY_PROFILE,
  SERENITY_DATA_UPDATED,
  buildSerenityIndex,
  buildSubIndices,
  fetchSerenityFeed,
  scorePick,
} from './serenity.js';
import {
  fetchDailyBatch,
  snapshotBatch,
  fetchQuoteMeta,
  fetchCompanyNews,
} from './stocks.js';
import { getCompany } from './companies.js';
import { runBacktest } from './backtest.js';
import { PmHistory, pmDeepStats, pmReflections } from './pmstats.js';
import { KOLS, fetchKolSignals } from './radar.js';

/** 版本号：与 data/version.json 同步，旧部署会被远端更高版本强制引导到最新地址 */
const APP_VERSION = 11;

const $ = (id) => document.getElementById(id);

const SUB_LABELS = {
  rsi: 'RSI(14) — 相对强弱指标',
  kdj: 'KDJ(9,3,3) — 随机指标',
  dmi: 'DMI(14) — 动向指标（+DI/-DI/ADX）',
  obv: 'OBV — 能量潮（累计成交量）',
};

const state = {
  symbol: 'BTCUSDT',
  interval: '1h',
  candles: [],
  candles1h: [], // 独立维护的1小时K线，用于成交量对比
  indicators: null,
  signals: [],
  anomalies: [],
  newsEvents: [],
  advice: null,
  unsubscribe: null,
  unsubWhale: null,
  usingMock: false,
  subIndicator: 'rsi',
};

const alerts = new AlertManager({ onAlert: showToast });
const whaleFeed = new WhaleFeed(30);
const reviewLog = new ReviewLog();
const pmHistory = new PmHistory();
const wallet = new PaperWallet();

/** Polymarket 5m 状态（仅BTC品种启用） */
const pm = {
  window: null, // fetchWindowMarket 结果
  strike: null, // 窗口开始价（以币安1m开盘价近似Chainlink）
  advice: null,
  flow: null,
  bookInfo: null,
  real: null, // 双边真实买价 { upAsk, downAsk, spreadCents }
  candles1m: [], // 独立的BTC 1分钟K线缓存
  tickBuffer: [], // 实时价格缓存 [{t, price}]，用于30秒动能
  priceLine: null,
  lockedWindow: null,
  lockedAdvice: null,
  passRecorded: null, // 已登记"放弃"的窗口
  reversalAlerted: null, // 已发反转警报的窗口
};

/** 实时BTC价格（币安ticker，失败回退1分钟K线收盘） */
async function fetchBtcTick() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    if (res.ok) {
      const d = await res.json();
      const p = parseFloat(d.price);
      if (p > 0) return p;
    }
  } catch (_) {
    /* fallthrough */
  }
  return pm.candles1m.length ? pm.candles1m[pm.candles1m.length - 1].close : null;
}

// ---------------- 图表初始化 ----------------

/** 图表坐标轴时间统一显示为 UTC+8 */
function chartTickUTC8(t, tickType) {
  const d = new Date((t + 8 * 3600) * 1000);
  const pad = (x) => String(x).padStart(2, '0');
  if (tickType === 0) return String(d.getUTCFullYear()); // 年
  if (tickType === 1 || tickType === 2)
    return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; // 月/日
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; // 日内
}

const chartOpts = {
  layout: { background: { color: 'transparent' }, textColor: '#d7dde8' },
  grid: {
    vertLines: { color: 'rgba(38,48,67,.5)' },
    horzLines: { color: 'rgba(38,48,67,.5)' },
  },
  timeScale: {
    timeVisible: true,
    secondsVisible: false,
    borderColor: '#263043',
    tickMarkFormatter: chartTickUTC8,
  },
  localization: {
    timeFormatter: (t) => `${formatTime(t)} (UTC+8)`,
  },
  rightPriceScale: { borderColor: '#263043' },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  autoSize: true,
};

const mainChart = LightweightCharts.createChart($('mainChart'), chartOpts);
const macdChart = LightweightCharts.createChart($('macdChart'), chartOpts);
const subChart = LightweightCharts.createChart($('subChart'), chartOpts);

const candleSeries = mainChart.addCandlestickSeries({
  upColor: '#26a69a',
  downColor: '#ef5350',
  wickUpColor: '#26a69a',
  wickDownColor: '#ef5350',
  borderVisible: false,
});
const bollUpper = mainChart.addLineSeries({ color: 'rgba(77,148,255,.7)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
const bollMiddle = mainChart.addLineSeries({ color: 'rgba(230,184,0,.8)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
const bollLower = mainChart.addLineSeries({ color: 'rgba(77,148,255,.7)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

// 主图底部叠加成交量柱
const volumeSeries = mainChart.addHistogramSeries({
  priceFormat: { type: 'volume' },
  priceScaleId: 'vol',
  priceLineVisible: false,
  lastValueVisible: false,
});
mainChart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

const macdHist = macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
const macdDif = macdChart.addLineSeries({ color: '#e6b800', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
const macdDea = macdChart.addLineSeries({ color: '#4d94ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

let subSeries = [];
let subSeriesType = null;

function syncTimeScales(charts) {
  let syncing = false;
  for (const src of charts) {
    src.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (syncing || !range) return;
      syncing = true;
      for (const dst of charts) {
        if (dst !== src) dst.timeScale().setVisibleLogicalRange(range);
      }
      syncing = false;
    });
  }
}
syncTimeScales([mainChart, macdChart, subChart]);

// ---------------- 数据加载与实时订阅 ----------------

let loadToken = 0;

async function loadSymbol() {
  const token = ++loadToken;
  if (state.unsubscribe) {
    state.unsubscribe();
    state.unsubscribe = null;
  }
  if (state.unsubWhale) {
    state.unsubWhale();
    state.unsubWhale = null;
  }
  whaleFeed.clear();
  alerts.reset();
  setStatus('加载历史K线…', '');

  try {
    const candles = await fetchHistory(state.symbol, state.interval, 500);
    if (token !== loadToken) return;
    state.candles = candles;
    state.usingMock = false;
    state.unsubscribe = subscribeKline(
      state.symbol,
      state.interval,
      onRealtimeBar,
      () => setStatus('行情连接异常，自动重连中', 'err')
    );
    state.unsubWhale = subscribeWhaleTrades(state.symbol, onWhaleTrade);
    setStatus(`已连接 · ${getSymbol(state.symbol).label}`, 'ok');
  } catch (err) {
    if (token !== loadToken) return;
    state.candles = generateMockHistory(state.interval, 500);
    state.usingMock = true;
    setStatus('离线模式（模拟行情演示）', 'err');
    state.unsubscribe = subscribeMockKline(
      state.interval,
      state.candles[state.candles.length - 1],
      onRealtimeBar
    );
  }

  recomputeAndRender({ fitContent: true });
  removeStrikeLine();
  await refreshPm1mCandles();
  refreshAdvisorAndVolume();
  refreshNews();
  refreshPolymarket();
}

let lastFullRender = 0;

function onRealtimeBar(bar, isClosed) {
  const last = state.candles[state.candles.length - 1];
  if (last && bar.time === last.time) {
    state.candles[state.candles.length - 1] = bar;
  } else if (!last || bar.time > last.time) {
    state.candles.push(bar);
    if (state.candles.length > 1500) state.candles.shift();
  } else {
    return;
  }

  // 每个tick只做轻量增量更新（O(1)），避免全量重算导致卡顿
  candleSeries.update(bar);
  walletMark(state.symbol, bar.close);
  volumeSeries.update({
    time: bar.time,
    value: bar.volume,
    color: bar.close >= bar.open ? 'rgba(38,166,154,.4)' : 'rgba(239,83,80,.4)',
  });

  // 指标/信号/异动/侧栏的全量重算：仅在K线收盘或距上次超过5秒时进行
  const now = Date.now();
  if (isClosed || now - lastFullRender > 5000) {
    lastFullRender = now;
    recomputeAndRender({ fitContent: false });
  }
}

let whaleRenderQueued = false;
function onWhaleTrade(trade) {
  whaleFeed.push(trade);
  // 合并高频推送，最多每秒渲染一次
  if (whaleRenderQueued) return;
  whaleRenderQueued = true;
  setTimeout(() => {
    whaleRenderQueued = false;
    renderWhaleList();
  }, 1000);
}

/** innerHTML 只在内容变化时才写入，避免无谓的DOM重建 */
function setHtmlIfChanged(el, html) {
  if (el.__lastHtml === html) return false;
  el.__lastHtml = html;
  el.innerHTML = html;
  return true;
}

// ---------------- 计算 + 渲染 ----------------

function recomputeAndRender({ fitContent }) {
  const candles = state.candles;
  if (candles.length === 0) return;

  state.indicators = computeAll(candles);
  state.signals = generateSignals(candles, state.indicators);
  state.anomalies = detectCandleAnomalies(candles);

  // 风险信号提示音：只对最近一根已收盘K线上的新异动报警
  if (!state.usingMock && state.anomalies.length && candles.length >= 2) {
    const lastClosed = candles[candles.length - 2].time;
    for (const a of state.anomalies) {
      if (a.time !== lastClosed) continue;
      alerts.fireRisk({
        key: `anomaly|${state.symbol}|${a.time}|${a.type}`,
        title: `${getSymbol(state.symbol).label} 风险信号`,
        body: a.desc,
        kind: 'risk',
      });
    }
  }

  candleSeries.setData(candles);
  volumeSeries.setData(
    candles.map((c) => ({
      time: c.time,
      value: c.volume,
      color: c.close >= c.open ? 'rgba(38,166,154,.4)' : 'rgba(239,83,80,.4)',
    }))
  );

  const toLine = (arr) =>
    candles
      .map((c, i) => (arr[i] !== null ? { time: c.time, value: arr[i] } : null))
      .filter(Boolean);

  const { boll, macd } = state.indicators;
  bollUpper.setData(toLine(boll.upper));
  bollMiddle.setData(toLine(boll.middle));
  bollLower.setData(toLine(boll.lower));

  macdDif.setData(toLine(macd.dif));
  macdDea.setData(toLine(macd.dea));
  macdHist.setData(
    candles
      .map((c, i) =>
        macd.hist[i] !== null
          ? {
              time: c.time,
              value: macd.hist[i],
              color: macd.hist[i] >= 0 ? 'rgba(38,166,154,.7)' : 'rgba(239,83,80,.7)',
            }
          : null
      )
      .filter(Boolean)
  );

  renderSubIndicator();
  renderMarkers();
  renderSignalList();
  renderAnomalyList();
  renderEventList();

  // 只播报强度≥3的高确定性信号（低强度信号仅在列表展示，不打扰）
  const lastTime = candles[candles.length - 1].time;
  alerts.check(
    state.signals.filter((s) => s.time < lastTime && s.score >= 3),
    state.symbol
  );

  if (fitContent) mainChart.timeScale().fitContent();
}

const SUB_INDICATOR_LINES = {
  rsi: [{ color: '#e6b800', pick: (ind) => ind.rsi }],
  kdj: [
    { color: '#e6b800', pick: (ind) => ind.kdj.k },
    { color: '#4d94ff', pick: (ind) => ind.kdj.d },
    { color: '#ff7f2a', pick: (ind) => ind.kdj.j },
  ],
  dmi: [
    { color: '#26a69a', pick: (ind) => ind.dmi.pdi },
    { color: '#ef5350', pick: (ind) => ind.dmi.mdi },
    { color: '#e6b800', pick: (ind) => ind.dmi.adx },
  ],
  obv: [{ color: '#9966ff', pick: (ind) => ind.obv }],
};

function renderSubIndicator() {
  const candles = state.candles;
  const ind = state.indicators;
  const lines = SUB_INDICATOR_LINES[state.subIndicator];
  if (!lines || !ind) return;

  if (subSeriesType !== state.subIndicator) {
    for (const s of subSeries) subChart.removeSeries(s);
    subSeries = lines.map((l) =>
      subChart.addLineSeries({
        color: l.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      })
    );
    subSeriesType = state.subIndicator;
    $('subLabel').textContent = SUB_LABELS[state.subIndicator];
  }

  const toLine = (arr) =>
    candles
      .map((c, i) => (arr[i] !== null ? { time: c.time, value: arr[i] } : null))
      .filter(Boolean);
  lines.forEach((l, idx) => subSeries[idx].setData(toLine(l.pick(ind))));
}

// ---------------- 综合建议 + 成交量对比（每30分钟刷新） ----------------

/** 新闻面偏向：近24小时高/中影响新闻的多空净值（-1~1） */
function computeNewsBias() {
  const now = Math.floor(Date.now() / 1000);
  let sum = 0;
  let bull = 0;
  let bear = 0;
  for (const e of state.newsEvents || []) {
    if (now - e.time > 86400) continue;
    const it = interpret(e.title);
    const w = e.impact === 'high' ? 1 : 0.4;
    if (it.bias === 'bullish') {
      sum += w;
      bull++;
    } else if (it.bias === 'bearish') {
      sum -= w;
      bear++;
    }
  }
  if (bull + bear === 0) return null;
  const score = Math.tanh(sum / 4);
  return {
    score,
    reason: `新闻面（24h）：利好${bull}条 vs 利空${bear}条，净偏向${score >= 0 ? '偏多' : '偏空'}（${(score * 100).toFixed(0)}%权重按周期递减）`,
  };
}

/** 复盘经验：三层策略各自的近期命中率 */
function strategyExperience() {
  const stats = reviewLog.stats();
  const out = {};
  for (const st of STRATEGIES) {
    const s = stats[`advisor:${st.key}`];
    if (s) out[st.key] = s;
  }
  return out;
}

async function refreshAdvisorAndVolume() {
  const box = $('advisorBox');
  box.innerHTML = '<div class="advisor-loading">分析中…</div>';

  const fetchCandles = async (tf) => {
    if (state.usingMock) return generateMockHistory(tf, tf === '1d' ? 250 : 400);
    const c = await fetchHistory(state.symbol, tf, tf === '1d' ? 250 : 400);
    if (tf === '1h') state.candles1h = c;
    return c;
  };

  // 先结算到期预测，经验修正注入本轮建议
  settleReviews();

  try {
    state.advice = await runAdvisor(fetchCandles, {
      newsBias: computeNewsBias(),
      experience: strategyExperience(),
    });
  } catch (_) {
    state.advice = null;
  }
  if (state.usingMock) state.candles1h = generateMockHistory('1h', 400);

  recordAdvisorPredictions();
  notifyMajorSignals();
  considerAutoTrades();
  renderAdvisor();
  renderVolumePanel();
  renderReviewPanel();
  renderWalletTab();
}

// ---------------- 建议复盘：登记、结算、反思 ----------------

/** 登记本轮三层策略的方向预测（按各自持有周期到期验证） */
function recordAdvisorPredictions() {
  const adv = state.advice;
  if (!adv || state.usingMock) return;
  const now = Math.floor(Date.now() / 1000);
  const price = state.candles.length ? state.candles[state.candles.length - 1].close : null;
  if (!price) return;
  for (const st of adv.strategies) {
    if (st.action === '观望' || st.action === '数据不足') continue;
    const direction = st.score > 0 ? 'up' : 'down';
    reviewLog.record({
      source: `advisor:${st.key}`,
      symbol: state.symbol,
      direction,
      priceAtCall: price,
      callTime: now,
      evalTime: now + st.holdSec,
      note: st.action,
    });
  }
}

/** 重大信号：置顶 + 提示音推送 */
function notifyMajorSignals() {
  const adv = state.advice;
  if (!adv || state.usingMock) return;
  for (const st of adv.strategies) {
    if (!st.major) continue;
    const isBuy = st.score > 0;
    alerts.fireRisk({
      key: `major|${state.symbol}|${st.key}|${Math.floor(Date.now() / 1800000)}`,
      title: `⚡重大信号 ${getSymbol(state.symbol).label} ${st.label}：${st.action}`,
      body: `评分${st.score.toFixed(1)} · 置信度${(st.conf * 100).toFixed(0)}%` + (st.plan ? ` · 入场${st.plan.entry.toFixed(1)} 止损${st.plan.stop.toFixed(1)} 目标${st.plan.target.toFixed(1)}` : ''),
      kind: isBuy ? 'buy' : 'sell',
    });
  }
}

/** 用K线还原任意时刻的价格（供结算） */
function priceAt(symbol, timeSec) {
  const pools = [];
  if (symbol === state.symbol && state.candles.length) pools.push(state.candles);
  if (symbol === 'BTCUSDT' && pm.candles1m.length) pools.push(pm.candles1m);
  if (symbol === state.symbol && state.candles1h.length) pools.push(state.candles1h);
  for (const candles of pools) {
    if (candles[candles.length - 1].time < timeSec) continue; // 数据未覆盖评估点
    for (let i = candles.length - 1; i >= 0; i--) {
      if (candles[i].time <= timeSec) return candles[i].close;
    }
  }
  return null;
}

function settleReviews() {
  if (state.usingMock) return;
  reviewLog.settle(priceAt);
}

function renderReviewPanel() {
  const box = $('reviewBox');
  const stats = reviewLog.stats();
  const entries = Object.entries(stats);
  const recent = reviewLog.recent(6);
  const pending = reviewLog.pendingCount();

  if (entries.length === 0 && recent.length === 0) {
    setHtmlIfChanged(
      box,
      `<div class="advisor-loading">暂无已结算的预测${pending ? `（${pending}条待结算）` : ''}</div>`
    );
    return;
  }

  const STRATEGY_NAMES = { short: '短线1-6h', mid: '中短线6-24h', long: '长线1-3天' };
  const SRC_LABEL = (s) => {
    if (s.startsWith('advisor:')) {
      const k = s.split(':')[1];
      return `建议·${STRATEGY_NAMES[k] || k}`;
    }
    return s === 'polymarket:5m' ? 'PM 5分钟' : s;
  };

  const statHtml = entries
    .map(([src, s]) => {
      const pct = s.hitRate !== null ? (s.hitRate * 100).toFixed(0) : '-';
      const cls = s.hitRate >= 0.55 ? 'good' : s.hitRate < 0.45 ? 'bad' : '';
      return `<div class="rv-stat"><span>${SRC_LABEL(src)}</span><span class="rv-rate ${cls}">${s.hits}/${s.total} 命中 ${pct}%</span></div>`;
    })
    .join('');

  const reflectHtml =
    state.reflections && state.reflections.length
      ? `<div class="rv-reflect">反思：${state.reflections.map(escapeHtml).join('；')}</div>`
      : '';

  const recentHtml = recent
    .map(
      (r) =>
        `<div class="rv-item"><span class="rv-${r.outcome}">${r.outcome === 'hit' ? '✓' : '✗'}</span> ` +
        `${SRC_LABEL(r.source)} 预测${r.direction === 'up' ? '涨' : '跌'} → 实际${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(2)}%` +
        `<br><span class="time">${formatTime(r.callTime)} 判定于 ${formatTime(r.evalTime)}</span></div>`
    )
    .join('');

  setHtmlIfChanged(
    box,
    statHtml + reflectHtml + recentHtml + (pending ? `<div class="rv-item">另有 ${pending} 条预测待结算</div>` : '')
  );
}

function actionClass(action) {
  if (action.includes('买') || action.includes('多')) return 'buy';
  if (action.includes('卖') || action.includes('减')) return 'sell';
  return 'hold';
}

function renderAdvisor() {
  const box = $('advisorBox');
  const adv = state.advice;
  if (!adv) {
    box.innerHTML = '<div class="advisor-loading">分析失败，请点击下方按钮重试</div>';
    return;
  }

  // 重大信号置顶
  const ordered = [...adv.strategies].sort((a, b) => Number(b.major) - Number(a.major));

  const cards = ordered
    .map((st) => {
      const planHtml = st.plan
        ? `<div class="plan"><b>交易计划（${st.plan.direction === 'long' ? '做多' : '做空'}·杠杆≤${st.plan.leverage}x）</b><br>` +
          `入场 ${st.plan.entry.toFixed(1)} · 止损 ${st.plan.stop.toFixed(1)} · 目标 ${st.plan.target.toFixed(1)}` +
          (st.plan.rr ? ` · 盈亏比 1:${st.plan.rr.toFixed(1)}` : '') +
          `<br>${escapeHtml(st.plan.note)}</div>`
        : '';
      const reasons = st.reasons.map((x) => `<li>${escapeHtml(x)}</li>`).join('');
      return (
        `<div class="st-card ${st.major ? 'major' : ''}">` +
        `<div class="st-head"><span class="st-label">${st.major ? '🔔 ' : ''}${escapeHtml(st.label)}</span>` +
        `<span class="action ${actionClass(st.action)}">${escapeHtml(st.action)}</span></div>` +
        `<div class="sy-note">评分 ${st.score.toFixed(1)} · 置信度 ${(st.conf * 100).toFixed(0)}%</div>` +
        planHtml +
        `<details class="tf-row"><summary class="tf-head"><span class="tf-name">推理依据（${st.reasons.length}条）</span></summary>` +
        `<ul class="tf-reasons">${reasons}</ul></details>` +
        `</div>`
      );
    })
    .join('');

  box.innerHTML =
    `<span class="upd">更新于 ${formatTime(adv.updatedAt)}${state.usingMock ? '（模拟数据）' : ''} · 建议已融合新闻面与历史复盘经验</span>` +
    cards;
}

function renderVolumePanel() {
  const candles1h = state.candles1h;
  const summaryEl = $('volumeSummary');
  const tbody = $('volumeTable').querySelector('tbody');
  if (!candles1h || candles1h.length < 48) {
    summaryEl.textContent = '1小时K线数据不足';
    tbody.innerHTML = '';
    return;
  }

  const r24 = rolling24hVolume(candles1h);
  if (r24) {
    const cls = r24.changePct >= 0 ? 'up' : 'down';
    summaryEl.innerHTML =
      `近24小时总量 <b>${formatVolume(r24.last24)}</b>，前24小时 ${formatVolume(r24.prev24)}，` +
      `变化 <span class="${cls}">${r24.changePct >= 0 ? '+' : ''}${r24.changePct.toFixed(1)}%</span>`;
  }

  const rows = hourlyVolumeStats(candles1h, 12);
  const maxVol = Math.max(...rows.map((r) => r.volume));
  tbody.innerHTML = rows
    .map((r) => {
      const d = new Date((r.time + 8 * 3600) * 1000); // UTC+8 显示
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const pctCell = (v) =>
        v === null
          ? '<td>-</td>'
          : `<td class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : ''}${v.toFixed(0)}%</td>`;
      const hot = r.volume === maxVol ? ' class="hot"' : '';
      return (
        `<tr${hot}><td>${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${hh}:00</td>` +
        `<td>${formatVolume(r.volume)}</td>${pctCell(r.vsPrevPct)}${pctCell(r.vsSameHourAvgPct)}</tr>`
      );
    })
    .join('');
}

// ---------------- 异常交易监控 ----------------

function renderAnomalyList() {
  const ul = $('anomalyList');
  const recent = state.anomalies.slice(0, 8);
  const html =
    recent.length === 0
      ? '<li class="reasons">当前周期暂无量价异动</li>'
      : recent
          .map(
            (a) =>
              `<li><span class="anomaly-tag">${a.type === 'both' ? '量价异动' : a.type === 'volume' ? '放量' : '价格异动'}</span>` +
              `${escapeHtml(a.desc)}<br><span class="time">${formatTime(a.time)}</span></li>`
          )
          .join('');
  setHtmlIfChanged(ul, html);
}

function renderWhaleList() {
  const ul = $('whaleList');
  const recent = whaleFeed.trades.slice(0, 8);
  const html = recent
    .map(
      (t) =>
        `<li><span class="whale-${t.side}">${t.side === 'buy' ? '⬆ 大额买入' : '⬇ 大额卖出'}</span>` +
        ` $${formatVolume(t.usd)} @ ${t.price.toFixed(2)}` +
        `<br><span class="time">${formatTime(t.time)} · ${t.source}</span></li>`
    )
    .join('');
  setHtmlIfChanged(ul, html);
}

// ---------------- 标注：信号 + 宏观事件 ----------------

function nearestCandleTime(t) {
  const candles = state.candles;
  if (candles.length === 0) return null;
  if (t < candles[0].time || t > candles[candles.length - 1].time) return null;
  let lo = 0;
  let hi = candles.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (candles[mid].time <= t) lo = mid;
    else hi = mid - 1;
  }
  return candles[lo].time;
}

const eventMarkerMap = new Map();

/** 全部事件源合并：内置+自定义+真实新闻（高影响新闻才上图） */
function chartEvents() {
  return getAllEvents(state.newsEvents.filter((e) => e.impact === 'high'));
}

function listEvents() {
  return [...getAllEvents([]), ...state.newsEvents].sort((a, b) => b.time - a.time);
}

function renderMarkers() {
  const markers = [];
  eventMarkerMap.clear();

  if ($('toggleSignals').checked) {
    for (const s of state.signals) {
      markers.push({
        time: s.time,
        position: s.side === 'buy' ? 'belowBar' : 'aboveBar',
        color: s.side === 'buy' ? '#26a69a' : '#ef5350',
        shape: s.side === 'buy' ? 'arrowUp' : 'arrowDown',
        text: s.side === 'buy' ? `B${s.score}` : `S${s.score}`,
      });
    }
  }

  if ($('toggleEvents').checked) {
    for (const evt of chartEvents()) {
      const t = nearestCandleTime(evt.time);
      if (t === null) continue;
      if (!eventMarkerMap.has(t)) eventMarkerMap.set(t, []);
      eventMarkerMap.get(t).push(evt);
      markers.push({
        time: t,
        position: 'aboveBar',
        color: EVENT_CATEGORIES[evt.category].color,
        shape: evt.impact === 'high' ? 'circle' : 'square',
        text: evt.title.length > 12 ? evt.title.slice(0, 12) + '…' : evt.title,
      });
    }
  }

  markers.sort((a, b) => a.time - b.time);
  candleSeries.setMarkers(markers);
}

const tooltip = $('tooltip');
mainChart.subscribeCrosshairMove((param) => {
  if (!param.time || !eventMarkerMap.has(param.time)) {
    tooltip.classList.add('hidden');
    return;
  }
  const evts = eventMarkerMap.get(param.time);
  tooltip.innerHTML = evts
    .map(
      (e) =>
        `<div class="tt-title">${escapeHtml(e.title)}</div>` +
        `<div class="tt-note">${formatTime(e.time)} · ${EVENT_CATEGORIES[e.category].label}` +
        (e.note ? `<br>${escapeHtml(e.note)}` : '') +
        `</div>`
    )
    .join('<hr style="border-color:#263043">');
  tooltip.classList.remove('hidden');
  const rect = $('mainChart').getBoundingClientRect();
  tooltip.style.left = `${Math.min(rect.left + (param.point?.x ?? 0) + 16, window.innerWidth - 320)}px`;
  tooltip.style.top = `${rect.top + (param.point?.y ?? 0) + 16}px`;
});

// ---------------- 侧栏渲染 ----------------

/** 全站统一 UTC+8（北京时间）显示 */
function formatTime(t) {
  const d = new Date((t + 8 * 3600) * 1000);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderSignalList() {
  const ul = $('signalList');
  const recent = state.signals.slice(-20).reverse();
  const html =
    recent.length === 0
      ? '<li class="reasons">暂无信号</li>'
      : recent
          .map(
            (s) =>
              `<li><span class="side-${s.side}">${s.side === 'buy' ? '▲ 买入' : '▼ 卖出'}</span>` +
              ` <span>@${s.price.toFixed(2)}</span> <span>强度${s.score}</span>` +
              `<br><span class="time">${formatTime(s.time)}</span>` +
              `<br><span class="reasons">${escapeHtml(s.reasons.join('；'))}</span></li>`
          )
          .join('');
  setHtmlIfChanged(ul, html);
}

function eventItemHtml(e) {
  const cat = EVENT_CATEGORIES[e.category];
  const del = e.id.startsWith('c')
    ? `<button class="del" data-id="${e.id}" title="删除">✕</button>`
    : '';
  const src = e.source ? `<span class="src-tag">${escapeHtml(e.source)}</span>` : '';
  const title = e.url
    ? `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.title)}</a>`
    : escapeHtml(e.title);
  const it = interpret(e.title);
  return (
    `<li>${del}<details><summary>` +
    `<span class="bias ${it.bias}">${it.biasLabel}</span>` +
    `<span class="cat" style="background:${cat.color}">${cat.label}</span>${src}` +
    `${title}<br><span class="time">${formatTime(e.time)}</span></summary>` +
    `<div class="interp">` +
    `<b>影响对象：</b>${escapeHtml(it.target)}<br>` +
    `<b>${it.biasLabel}逻辑：</b>${escapeHtml(it.reason)}<br>` +
    `<b>需规避的风险：</b>${escapeHtml(it.risk)}` +
    `</div></details>` +
    (e.note && !e.source ? `<span class="note">${escapeHtml(e.note)}</span>` : '') +
    `</li>`
  );
}

function renderEventList() {
  const events = listEvents().slice(0, 60);
  const macro = [];
  const micro = [];
  for (const e of events) {
    (interpret(e.title).scope === 'macro' ? macro : micro).push(e);
  }

  for (const [ul, items, empty] of [
    [$('macroList'), macro.slice(0, 20), '暂无宏观信息'],
    [$('microList'), micro.slice(0, 20), '暂无微观信息'],
  ]) {
    const html = items.length
      ? items.map(eventItemHtml).join('')
      : `<li class="reasons">${empty}</li>`;
    if (!setHtmlIfChanged(ul, html)) continue;
    ul.querySelectorAll('.del').forEach((btn) =>
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        removeCustomEvent(btn.dataset.id);
        renderMarkers();
        renderEventList();
      })
    );
  }
}

function showToast({ signal, title, body }) {
  const div = document.createElement('div');
  div.className = `toast ${signal.side}`;
  div.innerHTML = `<div class="t-title">${escapeHtml(title)}</div><div class="t-body">${escapeHtml(body)}</div>`;
  $('toastContainer').appendChild(div);
  setTimeout(() => div.remove(), 8000);
}

function setStatus(text, cls) {
  const el = $('connStatus');
  el.textContent = text;
  el.className = `status ${cls}`;
}

// ---------------- Polymarket BTC 5分钟玩法 ----------------

function pmActive() {
  return state.symbol === 'BTCUSDT' && !state.usingMock;
}

/** 维护独立的BTC 1分钟K线缓存（每60秒刷新） */
async function refreshPm1mCandles() {
  if (!pmActive()) return;
  try {
    pm.candles1m = await fetchHistory('BTCUSDT', '1m', 180);
  } catch (_) {
    /* 保留旧缓存 */
  }
}

/** 主循环：每15秒刷新市场、订单簿、成交流并更新建议 */
async function refreshPolymarket() {
  const panel = $('pmPanel');
  if (!pmActive()) {
    panel.style.display = 'none';
    $('pmUnavailable').style.display = '';
    removeStrikeLine();
    settlePmHistory();
    renderPmStats();
    return;
  }
  panel.style.display = '';
  $('pmUnavailable').style.display = 'none';

  const winStart = currentWindowStart();
  try {
    // 窗口切换或首次：拉市场信息
    if (!pm.window || pm.window.startSec !== winStart) {
      pm.window = await fetchWindowMarket(winStart);
      pm.strike = null;
    }
    if (!pm.window) {
      setHtmlIfChanged($('pmBox'), '<div class="advisor-loading">本窗口市场尚未创建，等待下一期…</div>');
      return;
    }

    // 目标价：窗口起始1分钟K线的开盘价（近似Chainlink起始价）
    if (!pm.strike) {
      const startBar = pm.candles1m.find((c) => c.time === winStart);
      if (startBar) pm.strike = startBar.open;
    }

    // 订单簿（双边真实买价）+ 成交流 + 实时tick
    const [real, trades, tick] = await Promise.all([
      fetchRealPrices(pm.window.upTokenId, pm.window.downTokenId),
      pm.window.conditionId ? fetchTrades(pm.window.conditionId, 100) : [],
      fetchBtcTick(),
    ]);
    pm.real = real;
    pm.bookInfo = real && real.upBook ? analyzeBook(real.upBook) : null;
    pm.flow = analyzeTrades(trades.filter((t) => Number(t.timestamp) >= winStart));
    if (tick) {
      const nowT = Math.floor(Date.now() / 1000);
      pm.tickBuffer.push({ t: nowT, price: tick });
      while (pm.tickBuffer.length > 80) pm.tickBuffer.shift(); // ~20分钟
    }

    const secondsLeft = Math.max(0, pm.window.endSec - Math.floor(Date.now() / 1000));
    const nowSec = Math.floor(Date.now() / 1000);

    // ===== 每期一次决策：从开盘就侦察，信号充分立即出手（越早筹码越便宜） =====
    if (pm.lockedWindow === winStart) {
      pm.advice = pm.lockedAdvice; // 已决策，本期不改口
    } else {
      const scouting = advise5m({
        candles1m: pm.candles1m,
        tickBuffer: pm.tickBuffer,
        strikePrice: pm.strike,
        upAsk: real ? real.upAsk : null,
        downAsk: real ? real.downAsk : null,
        flow: pm.flow,
        book: pm.bookInfo,
        secondsLeft,
      });
      pm.advice = scouting;

      // 规则2：反转警报（每窗口一次）
      if (scouting.reversalAlert && pm.reversalAlerted !== winStart) {
        pm.reversalAlerted = winStart;
        alerts.fireRisk({
          key: `pmreversal|${winStart}`,
          title: 'PM 5分钟 ⚠ 潜在反转警报',
          body: scouting.reasons.find((r) => r.includes('反转警报')) || '价格大幅领先但双边筹码接近，市场押注反转',
          kind: 'risk',
        });
      }

      const recordSnapshot = (advice, secLeft) => {
        if (!pm.strike || !pm.candles1m.length) return;
        const cur = pm.tickBuffer.length ? pm.tickBuffer[pm.tickBuffer.length - 1].price : pm.candles1m[pm.candles1m.length - 1].close;
        pmHistory.record({
          winStart,
          winEnd: pm.window.endSec,
          action: advice.action,
          edge: advice.edge,
          techProb: advice.techProb,
          cost: advice.cost,
          potentialRoiPct: advice.potentialRoiPct,
          evRoiPct: advice.evRoiPct,
          strike: pm.strike,
          priceAtCall: cur,
          secondsLeftAtCall: secLeft,
          leadPct: ((cur - pm.strike) / pm.strike) * 100,
          flowBias:
            pm.flow && pm.flow.upFlow + pm.flow.downFlow > 0
              ? pm.flow.netUpFlow / (pm.flow.upFlow + pm.flow.downFlow)
              : null,
          bookImbalance: pm.bookInfo ? pm.bookInfo.imbalance : null,
          upPrice: real && real.upAsk !== null ? real.upAsk : pm.window.upPrice,
          reasons: advice.reasons,
        });
      };

      if (scouting.decided) {
        // 一次性锁定
        pm.lockedWindow = winStart;
        pm.lockedAdvice = scouting;
        recordSnapshot(scouting, secondsLeft);
        reviewLog.record({
          source: 'polymarket:5m',
          symbol: 'BTCUSDT',
          direction: scouting.action === '买Up' ? 'up' : 'down',
          priceAtCall: pm.strike,
          callTime: nowSec,
          evalTime: pm.window.endSec,
          note: `唯一决策@剩余${secondsLeft}s`,
        });
        alerts.fireRisk({
          key: `pmcall|${winStart}|${scouting.action}`,
          title: `Polymarket 5分钟信号：${scouting.action}（本期唯一决策·剩余${secondsLeft}秒）`,
          body: `真实成本${(scouting.cost * 100).toFixed(0)}¢ · 命中ROI +${scouting.potentialRoiPct.toFixed(0)}% · 期望ROI ${scouting.evRoiPct >= 0 ? '+' : ''}${scouting.evRoiPct.toFixed(0)}%`,
          kind: scouting.action === '买Up' ? 'buy' : 'sell',
        });
        if (scouting.evRoiPct >= 10) {
          const stake = scouting.conf >= 0.6 ? 100 : scouting.conf >= 0.4 ? 75 : 50;
          wallet.placePmBet({
            winStart,
            side: scouting.action === '买Up' ? 'up' : 'down',
            cost: scouting.cost, // 真实卖一价
            stake,
            time: nowSec,
            reason: `置信度${(scouting.conf * 100).toFixed(0)}%·真实价${(scouting.cost * 100).toFixed(0)}¢·期望ROI+${scouting.evRoiPct.toFixed(0)}%`,
          });
          renderWalletTab();
        }
      } else if (secondsLeft < 20 && pm.passRecorded !== winStart) {
        // 全程未出手：登记一次"放弃"供复盘
        pm.passRecorded = winStart;
        recordSnapshot({ ...scouting, action: '本期未出手（信号/价格条件未满足）' }, secondsLeft);
      }
    }
    settlePmHistory();

    renderPmPanel(secondsLeft);
    renderPmStats();
    updateStrikeLine();
  } catch (_) {
    setHtmlIfChanged($('pmBox'), '<div class="advisor-loading">Polymarket数据获取失败，将自动重试</div>');
  }
}

/** 结算5分钟历史：用1分钟K线还原窗口结束价，并结算模拟钱包PM注单 */
function settlePmHistory() {
  if (!pm.candles1m.length) return;
  const settled = pmHistory.settle((timeSec) => {
    // 窗口结束价 = 覆盖该时刻的1分钟K线收盘价
    for (let i = pm.candles1m.length - 1; i >= 0; i--) {
      const c = pm.candles1m[i];
      if (c.time <= timeSec - 60) return c.close; // 结束前最后一根完整1m线
    }
    return null;
  });
  let anyBet = false;
  for (const r of settled) {
    const res = wallet.settlePmBet(r.winStart, r.outcome);
    if (res) {
      anyBet = true;
      alerts.fireRisk({
        key: `pmsettle|${r.winStart}`,
        title: `PM注单结算：${res.won ? '✓盈利' : '✗亏损'} ${res.pnl >= 0 ? '+' : ''}$${res.pnl.toFixed(0)}`,
        body: `${res.side === 'up' ? '押涨' : '押跌'} $${res.stake} @${(res.cost * 100).toFixed(0)}¢ → ROI ${res.roiPct >= 0 ? '+' : ''}${res.roiPct.toFixed(0)}%`,
        kind: res.won ? 'buy' : 'sell',
      });
    }
  }
  if (anyBet) renderWalletTab();
}

function renderPmStats() {
  const box = $('pmStatsBox');
  const stats = pmDeepStats(pmHistory.records);
  if (!stats) {
    setHtmlIfChanged(
      box,
      `<div class="advisor-loading">暂无已结算的方向预测${pmHistory.pendingCount() ? `（${pmHistory.pendingCount()}期待结算）` : ''}</div>`
    );
    return;
  }
  const pct = (x) => (x * 100).toFixed(0) + '%';

  const bucketRows = (title, buckets) =>
    `<div class="rv-stat"><span><b>${title}</b></span><span></span></div>` +
    Object.entries(buckets)
      .map(([k, b]) => {
        const rate = b.hits / b.total;
        const cls = rate >= 0.55 ? 'good' : rate < 0.45 ? 'bad' : '';
        return `<div class="rv-stat"><span>${escapeHtml(k)}</span><span class="rv-rate ${cls}">${b.hits}/${b.total} · ${pct(rate)}</span></div>`;
      })
      .join('');

  const reflectHtml = `<div class="rv-reflect">${pmReflections(stats).map(escapeHtml).join('<br>')}</div>`;

  const histHtml = pmHistory
    .settledCalls(12)
    .map((r) => {
      const cls = r.hit ? 'rv-hit' : 'rv-miss';
      const missNote = r.missCause
        ? `<div class="interp"><b>错误归因：${escapeHtml(r.missCause.label)}</b><br>${escapeHtml(r.missCause.detail)}</div>`
        : '';
      const roiTag =
        typeof r.roiPct === 'number'
          ? `，ROI ${r.roiPct >= 0 ? '+' : ''}${r.roiPct.toFixed(0)}%（成本${(r.cost * 100).toFixed(0)}¢）`
          : '';
      return (
        `<details class="pm-hist-item"><summary><span class="${cls}">${r.hit ? '✓' : '✗'}</span> ` +
        `${formatTime(r.winStart)} ${escapeHtml(r.action)} → 实际${r.outcome === 'up' ? '涨' : '跌'}${roiTag}</summary>` +
        `<ul class="reasons-list">${(r.reasons || []).map((x) => `<li>· ${escapeHtml(x)}</li>`).join('')}</ul>` +
        `<div class="sy-note">目标价${r.strike.toFixed(1)} · 下单价${r.priceAtCall.toFixed(1)} · 结束价${r.endPrice ? r.endPrice.toFixed(1) : '-'}</div>` +
        missNote +
        `</details>`
      );
    })
    .join('');

  const roiRow =
    typeof stats.avgRoiPct === 'number'
      ? `<div class="rv-stat"><span>平均ROI/期</span><span class="rv-rate ${stats.avgRoiPct >= 0 ? 'good' : 'bad'}">${stats.avgRoiPct >= 0 ? '+' : ''}${stats.avgRoiPct.toFixed(0)}%</span></div>` +
        `<div class="rv-stat"><span>累计ROI（1单位/期）</span><span class="rv-rate ${stats.cumRoiPct >= 0 ? 'good' : 'bad'}">${stats.cumRoiPct >= 0 ? '+' : ''}${stats.cumRoiPct.toFixed(0)}%</span></div>` +
        `<div class="rv-stat"><span>平均买入成本</span><span>${(stats.avgCost * 100).toFixed(0)}¢</span></div>`
      : '';

  setHtmlIfChanged(
    box,
    `<div class="rv-stat"><span>累计方向预测</span><span>${stats.total}次</span></div>` +
      `<div class="rv-stat"><span>命中率</span><span class="rv-rate ${stats.hitRate >= 0.55 ? 'good' : stats.hitRate < 0.45 ? 'bad' : ''}">${pct(stats.hitRate)}</span></div>` +
      roiRow +
      `<div class="rv-stat"><span>理论盈亏（1单位/次）</span><span class="rv-rate ${stats.pnl >= 0 ? 'good' : 'bad'}">${stats.pnl >= 0 ? '+' : ''}${stats.pnl.toFixed(2)}</span></div>` +
      bucketRows('按剩余时间', stats.timeBuckets) +
      bucketRows('按edge区间', stats.edgeBuckets) +
      reflectHtml +
      `<div style="margin-top:6px"><b>历史回滚（点击展开当期推理）</b></div>` +
      histHtml
  );
}

function renderPmPanel(secondsLeft) {
  const w = pm.window;
  const a = pm.advice;
  const actionCls = a.action === '买Up' ? 'up' : a.action === '买Down' ? 'down' : 'hold';

  const bigHtml =
    pm.flow && pm.flow.bigTrades.length
      ? `<div class="pm-big"><b>大额订单（本窗口）</b>` +
        pm.flow.bigTrades
          .slice(0, 4)
          .map(
            (t) =>
              `<li>${t.direction === 'up' ? '🟢押涨' : '🔴押跌'} $${t.usd.toFixed(0)} @${(t.price * 100).toFixed(0)}¢ · ${escapeHtml(t.trader)}</li>`
          )
          .join('') +
        `</div>`
      : '';

  const anomalyHtml =
    pm.flow && pm.flow.anomalies.length
      ? `<div class="pm-big"><b>异常订单</b>` +
        pm.flow.anomalies.map((x) => `<li>⚠ ${escapeHtml(x.desc)}</li>`).join('') +
        `</div>`
      : '';

  const upShow = pm.real && pm.real.upAsk !== null ? pm.real.upAsk : w.upPrice;
  const downShow = pm.real && pm.real.downAsk !== null ? pm.real.downAsk : w.downPrice;
  setHtmlIfChanged(
    $('pmBox'),
    `<div class="pm-q">${escapeHtml(w.question)} · <a href="${escapeHtml(w.url)}" target="_blank" rel="noopener noreferrer">开市场↗</a></div>` +
      `<div class="pm-odds">` +
      `<div class="pm-odd up">${upShow !== null ? (upShow * 100).toFixed(0) + '¢' : '-'}<small>Up 真实买价(卖一)</small></div>` +
      `<div class="pm-odd down">${downShow !== null ? (downShow * 100).toFixed(0) + '¢' : '-'}<small>Down 真实买价(卖一)</small></div>` +
      `</div>` +
      (pm.strike
        ? `<div class="pm-strike">🎯 目标价 ${pm.strike.toFixed(1)}（已画到K线图，币安1m开盘价近似Chainlink）</div>`
        : `<div class="pm-strike">目标价待窗口起始K线生成…</div>`) +
      `<span class="pm-action ${actionCls}">${escapeHtml(a.action)}</span>` +
      `<span class="upd"> 置信度${a.conf !== undefined ? (a.conf * 100).toFixed(0) : '-'}%` +
      (a.cost !== null && a.cost !== undefined
        ? ` · 成本${(a.cost * 100).toFixed(0)}¢ · 命中ROI +${a.potentialRoiPct.toFixed(0)}% · 期望ROI ${a.evRoiPct >= 0 ? '+' : ''}${a.evRoiPct.toFixed(0)}%`
        : '') +
      `</span>` +
      `<ul>${a.reasons.map((r) => `<li>· ${escapeHtml(r)}</li>`).join('')}</ul>` +
      bigHtml +
      anomalyHtml
  );
  $('pmCountdown').textContent = `剩余 ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;
}

function updateStrikeLine() {
  removeStrikeLine();
  if (pm.strike && pmActive() && ['1m', '5m', '15m'].includes(state.interval)) {
    pm.priceLine = candleSeries.createPriceLine({
      price: pm.strike,
      color: '#e6b800',
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'PM 5m目标价',
    });
  }
}

function removeStrikeLine() {
  if (pm.priceLine) {
    candleSeries.removePriceLine(pm.priceLine);
    pm.priceLine = null;
  }
}

// 倒计时每秒走字（不发请求）
setInterval(() => {
  if (!pm.window || !pmActive()) return;
  const secondsLeft = Math.max(0, pm.window.endSec - Math.floor(Date.now() / 1000));
  $('pmCountdown').textContent = `剩余 ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;
}, 1000);

// ---------------- Serenity 指数与推荐组合 ----------------

let serenityLoaded = false;

async function refreshSerenity() {
  if (serenityLoaded) return;
  serenityLoaded = true;

  const tickers = [...new Set(SERENITY_PICKS.map((p) => p.ticker))];

  // 先用内置快照秒开渲染，再在后台尝试实时数据并覆盖
  const snap = await snapshotBatch(tickers);
  renderSerenity(snap, 'snapshot');

  try {
    const live = await fetchDailyBatch(tickers);
    const liveCount = Object.values(live).filter(Boolean).length;
    if (liveCount >= tickers.length / 2) {
      // 实时数据过半才切换；缺的用快照补齐
      for (const t of tickers) if (!live[t]) live[t] = snap[t];
      renderSerenity(live, 'live');
    }
  } catch (_) {
    /* 保持快照渲染 */
  }
}

function renderSerenity(daily, mode) {
  // 行业子指数
  const subs = buildSubIndices(daily);
  const subBox = $('serenitySubBox');
  if (subs.length) {
    subBox.innerHTML = subs
      .map((s) => {
        const cls = s.index.changePct >= 0 ? 'good' : 'bad';
        return (
          `<div class="rv-stat">` +
          `<span><span class="sy-tag" style="background:${s.color}">${s.label}</span> ` +
          `<span class="sy-note">${s.tickers.join(' ')}</span></span>` +
          `<span class="rv-rate ${cls}">${s.index.current.toFixed(1)}（${s.index.changePct >= 0 ? '+' : ''}${s.index.changePct.toFixed(1)}%）</span>` +
          `</div>`
        );
      })
      .join('') +
      `<div class="sy-note" style="margin-top:3px">子指数=该行业成分等权、基期100 · "Serenity指数-激光/-封装/-光模块…"</div>`;
  } else {
    subBox.innerHTML = '<div class="advisor-loading">行情不足，无法合成子指数</div>';
  }

  // 指数
  const idx = buildSerenityIndex(daily);
  const idxBox = $('serenityIndexBox');
  if (idx) {
    const cls = idx.changePct >= 0 ? 'up' : 'down';
    const step = Math.ceil(idx.series.length / 20);
    const spark = idx.series
      .map((p, i) =>
        i % step === 0 || i === idx.series.length - 1 ? p.value.toFixed(1) : null
      )
      .filter(Boolean)
      .join(' → ');
    idxBox.innerHTML =
      `<span class="sy-idx ${cls}">${idx.current.toFixed(2)}</span> ` +
      `<span class="rv-rate ${cls === 'up' ? 'good' : 'bad'}">${idx.changePct >= 0 ? '+' : ''}${idx.changePct.toFixed(2)}% / 30天</span>` +
      `<div class="sy-note">覆盖${idx.covered}/${idx.total}只成分 · 等权重 · 基期=100` +
      `${mode === 'snapshot' ? ' · 内置快照数据' : ' · 实时数据'}</div>` +
      `<div class="sy-note">走势：${spark}</div>`;
  } else {
    idxBox.innerHTML = '<div class="advisor-loading">行情不可用，无法合成指数</div>';
  }

  // 组合表（按评分排序）；点击行展开个股详情
  const rows = SERENITY_PICKS.map((p) => {
    const d = daily[p.ticker];
    const { score, perf30 } = scorePick(p, d ? d.candles : null);
    return { ...p, score, perf30 };
  }).sort((a, b) => b.score - a.score);

  const box = $('serenityPicksBox');
  box.innerHTML =
    rows
      .map((r) => {
        const ind = INDUSTRIES[r.industry];
        const perfCls = r.perf30 === null ? '' : r.perf30 >= 0 ? 'up' : 'down';
        const co = getCompany(r.ticker);
        return (
          `<div class="sy-pick" data-ticker="${escapeHtml(r.ticker)}">` +
          `<div class="sy-pick-head">` +
          `<span><b>${escapeHtml(r.ticker)}</b>${r.disclosed ? ' ◆' : ''} <span class="sy-note">${escapeHtml(co.cn)}</span></span>` +
          `<span><span class="sy-tag" style="background:${ind.color}">${ind.label}</span> ` +
          `<span class="${perfCls}">${r.perf30 === null ? '-' : (r.perf30 >= 0 ? '+' : '') + r.perf30.toFixed(1) + '%'}</span> ` +
          `<span class="sy-score">${r.score.toFixed(1)}</span></span>` +
          `</div>` +
          `<div class="sy-detail" id="syd-${escapeHtml(r.ticker)}"></div>` +
          `</div>`
        );
      })
      .join('') +
    `<div class="sy-note" style="margin-top:4px">◆=本人公开披露持仓 · 评分=叙事权重×2+30天动量+披露加成 · 点击任意标的展开详情</div>`;

  box.querySelectorAll('.sy-pick-head').forEach((head) => {
    head.addEventListener('click', () => {
      const pick = head.parentElement;
      const ticker = pick.dataset.ticker;
      const detail = $(`syd-${ticker}`);
      const open = detail.classList.toggle('open');
      if (open && !detail.dataset.loaded) {
        detail.dataset.loaded = '1';
        renderCompanyDetail(ticker, detail, rows.find((x) => x.ticker === ticker));
      }
    });
  });

  // 方法论
  const pr = SERENITY_PROFILE;
  $('serenityProfileBox').innerHTML =
    `<div class="rv-stat"><span>持股数据更新于</span><span>${formatTime(SERENITY_DATA_UPDATED)}</span></div>` +
    `<div class="rv-stat"><span>账号</span><span><a href="${pr.url}" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">${pr.handle}</a>（${pr.followers}粉丝）</span></div>` +
    `<div class="rv-stat"><span>风格</span><span>${escapeHtml(pr.style)}</span></div>` +
    `<div class="interp"><b>核心框架：</b>${escapeHtml(pr.framework)}</div>` +
    `<div class="interp"><b>代表战绩：</b>${escapeHtml(pr.record)}</div>` +
    `<div class="rv-reflect">${escapeHtml(pr.risk)}</div>`;
}

/** 渲染单只股票详情：公司资料 + 实时行情 + 竞品 + 买入理由 + challenge + 公司新闻 */
async function renderCompanyDetail(ticker, el, pick) {
  const co = getCompany(ticker);
  const nar = pick ? NARRATIVES[pick.narrative].label : '-';
  el.innerHTML =
    `<div class="co-name">${escapeHtml(co.name)}（${escapeHtml(co.cn)}）</div>` +
    `<div class="co-desc">${escapeHtml(co.desc)}</div>` +
    `<div class="co-quote" id="coq-${escapeHtml(ticker)}"><span class="sy-note">加载实时行情…</span></div>` +
    `<table class="co-fund"><tbody>` +
    `<tr><td>市值</td><td>${escapeHtml(co.mcap)}</td><td>市盈率PE</td><td>${escapeHtml(co.pe)}</td></tr>` +
    `<tr><td>市净率PB</td><td>${escapeHtml(co.pb)}</td><td>叙事定位</td><td>${escapeHtml(nar)}</td></tr>` +
    `</tbody></table>` +
    `<div class="co-sec"><b>赛道定位与排名：</b>${escapeHtml(co.rank)}</div>` +
    `<div class="co-sec"><b>主要竞品：</b>${co.peers.map((p) => `<span class="co-peer">${escapeHtml(p)}</span>`).join('')}</div>` +
    `<div class="co-sec"><b>财报要点：</b>${escapeHtml(co.financials)}</div>` +
    `<div class="interp co-bull"><b>为什么买它（我方逻辑）：</b>${escapeHtml(co.bull)}</div>` +
    `<div class="rv-reflect co-challenge"><b>Challenge Serenity（反方质疑）：</b>${escapeHtml(co.challenge)}</div>` +
    `<div class="co-news" id="con-${escapeHtml(ticker)}"><span class="sy-note">加载公司新闻…</span></div>`;

  // 实时行情（chart meta）
  fetchQuoteMeta(pick && pick.industry ? ticker : ticker)
    .then((q) => {
      const qe = $(`coq-${ticker}`);
      if (!qe) return;
      if (!q) {
        qe.innerHTML = '<span class="sy-note">实时行情不可达（可能被网络限制）</span>';
        return;
      }
      const range =
        q.high52 && q.low52
          ? ` · 52周 ${q.low52.toFixed(2)}~${q.high52.toFixed(2)}` +
            `（距高点${(((q.price - q.high52) / q.high52) * 100).toFixed(0)}%）`
          : '';
      qe.innerHTML = `<span class="co-price">${q.price.toFixed(2)} ${escapeHtml(q.currency)}</span><span class="sy-note">${range}</span>`;
    })
    .catch(() => {});

  // 公司新闻（雅虎单股 + 谷歌检索）
  fetchCompanyNews(ticker, co.name)
    .then((items) => {
      const ne = $(`con-${ticker}`);
      if (!ne) return;
      if (!items.length) {
        ne.innerHTML = '<span class="sy-note">暂无公司新闻或网络受限</span>';
        return;
      }
      ne.innerHTML =
        `<div class="co-news-h">最新公司新闻</div>` +
        items
          .slice(0, 6)
          .map(
            (it) =>
              `<div class="co-news-i"><a href="${escapeHtml(it.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(it.title)}</a>` +
              `<span class="sy-note"> · ${escapeHtml(it.source)} · ${formatTime(it.time)}</span></div>`
          )
          .join('');
    })
    .catch(() => {});
}

/** Serenity组合动态监控：近2天新闻 + 解读徽章，10分钟自动刷新 */
async function refreshSerenityFeed() {
  const box = $('serenityFeedBox');
  const items = await fetchSerenityFeed();
  if (!items.length) {
    setHtmlIfChanged(box, '<div class="advisor-loading">暂无近2天动态或网络受限</div>');
    return;
  }
  setHtmlIfChanged(
    box,
    items
      .map((it) => {
        const itp = interpret(it.title);
        return (
          `<div class="co-news-i"><span class="bias ${itp.bias}">${itp.biasLabel}</span>` +
          `<a href="${escapeHtml(it.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(it.title)}</a>` +
          `<span class="sy-note"> · ${formatTime(it.time)}</span></div>`
        );
      })
      .join('') +
      `<div class="sy-note" style="margin-top:4px">说明：X推文API需付费，无法直接抓取@aleabitoreddit实时推文；` +
      `本面板监控其重点标的的公开新闻作为替代信号，其X主页：` +
      `<a href="https://x.com/aleabitoreddit" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">x.com/aleabitoreddit</a></div>`
  );
}

// ---------------- 模拟交易钱包 ----------------

/** 高置信策略信号自动开仓（重大信号 + 有交易计划才出手，控制频率与风险） */
function considerAutoTrades() {
  const adv = state.advice;
  if (!adv || !state.candles.length) return;
  // 离线模拟行情下暂停自动交易：图表与指标用的是两条独立随机序列，
  // 价差会造成虚假的瞬间止损/止盈，污染绩效统计
  if (state.usingMock) return;
  const price = state.candles[state.candles.length - 1].close;
  const now = Math.floor(Date.now() / 1000);
  for (const st of adv.strategies) {
    if (!st.major || !st.plan) continue; // 只做多周期高度共振的重大信号
    if (st.plan.rr !== null && st.plan.rr < 1) continue; // 盈亏比<1不做，风险回报不对称
    // 杠杆按置信度在20-100x间分档（评分2.5→20x，3.5→50x，4.5→80x）
    const lev = Math.max(20, Math.min(100, Math.round(20 + (Math.abs(st.score) - 2.5) * 30)));
    const res = wallet.openPosition({
      symbol: state.symbol,
      side: st.plan.direction,
      price,
      margin: 500,
      leverage: lev,
      stop: st.plan.stop,
      target: st.plan.target,
      reason: `${st.label} ${st.action}（评分${st.score.toFixed(1)}）${state.usingMock ? '·模拟行情' : ''}`,
      time: now,
      strategy: st.key,
    });
    if (res && !res.rejected) {
      alerts.fireRisk({
        key: `walletopen|${res.id}`,
        title: `模拟钱包开仓：${getSymbol(state.symbol).label} ${st.plan.direction === 'long' ? '做多' : '做空'} ${lev}x`,
        body: `保证金$500 · 入场${price.toFixed(1)} · 止损${st.plan.stop.toFixed(1)} · 目标${st.plan.target.toFixed(1)}`,
        kind: st.plan.direction === 'long' ? 'buy' : 'sell',
      });
      renderWalletTab();
    }
  }
}

/** 价格驱动的持仓管理（止损/止盈/强平） */
function walletMark(symbol, price) {
  const closed = wallet.markPrice(symbol, price, Math.floor(Date.now() / 1000));
  for (const t of closed) {
    const causeLabel = { stop: '止损', target: '止盈', liquidated: '强平', manual: '手动' }[t.cause] || t.cause;
    alerts.fireRisk({
      key: `walletclose|${t.id}`,
      title: `模拟钱包平仓（${causeLabel}）：${t.netPnl >= 0 ? '✓盈利' : '✗亏损'} ${t.netPnl >= 0 ? '+' : ''}$${t.netPnl.toFixed(1)}`,
      body: `${t.symbol} ${t.side === 'long' ? '多' : '空'}${t.leverage}x · ${t.entry.toFixed(1)}→${t.exit.toFixed(1)} · ROI ${t.roiPct >= 0 ? '+' : ''}${t.roiPct.toFixed(1)}%`,
      kind: t.netPnl >= 0 ? 'buy' : 'risk',
    });
  }
  if (closed.length) renderWalletTab();
}

function renderWalletTab() {
  const box = $('walletBox');
  if (!box) return;
  const prices = {};
  if (state.candles.length) prices[state.symbol] = state.candles[state.candles.length - 1].close;
  const spotEq = wallet.equitySpot(prices);
  const pmEq = wallet.pmEquity();
  const total = spotEq + pmEq;
  const base = wallet.baseCapital || 11000;
  const totalRet = ((total - base) / base) * 100;
  const s = wallet.stats();
  const pct = (x) => (x === null ? '-' : (x * 100).toFixed(0) + '%');

  const posHtml = wallet.positions.length
    ? wallet.positions
        .map((p) => {
          const px = prices[p.symbol] ?? p.lastPrice;
          const u = wallet.unrealized(p, px);
          const cls = u >= 0 ? 'up' : 'down';
          return (
            `<div class="rv-stat"><span>${escapeHtml(p.symbol)} ${p.side === 'long' ? '多' : '空'}${p.leverage}x <span class="sy-note">@${p.entry.toFixed(1)}</span></span>` +
            `<span class="${cls}">${u >= 0 ? '+' : ''}$${u.toFixed(1)}（${((u / p.margin) * 100).toFixed(0)}%）</span></div>` +
            `<div class="sy-note">止损${p.stop !== null ? p.stop.toFixed(1) : '-'} · 目标${p.target !== null ? p.target.toFixed(1) : '-'} · ${escapeHtml(p.reason)}</div>`
          );
        })
        .join('')
    : '<div class="sy-note">当前无持仓（只在重大信号出现时开仓，不频繁交易）</div>';

  const betsHtml = wallet.bets.length
    ? wallet.bets.map((b) => `<div class="sy-note">进行中：${b.side === 'up' ? '押涨' : '押跌'} $${b.stake} @${(b.cost * 100).toFixed(0)}¢（${formatTime(b.winStart)}期）</div>`).join('')
    : '';

  const closedHtml = wallet.closed
    .slice(-8)
    .reverse()
    .map((t) => {
      const cls = t.netPnl >= 0 ? 'rv-hit' : 'rv-miss';
      const causeLabel = { stop: '止损', target: '止盈', liquidated: '强平', manual: '手动' }[t.cause] || t.cause;
      return `<div class="rv-item"><span class="${cls}">${t.netPnl >= 0 ? '✓' : '✗'}</span> ${escapeHtml(t.symbol)} ${t.side === 'long' ? '多' : '空'}${t.leverage}x ${causeLabel} ${t.netPnl >= 0 ? '+' : ''}$${t.netPnl.toFixed(1)}（ROI ${t.roiPct.toFixed(0)}%）<br><span class="time">${formatTime(t.openTime)} → ${formatTime(t.exitTime)}</span></div>`;
    })
    .join('');

  const betHistHtml = wallet.settledBets
    .slice(-8)
    .reverse()
    .map((b) => `<div class="rv-item"><span class="${b.won ? 'rv-hit' : 'rv-miss'}">${b.won ? '✓' : '✗'}</span> PM ${b.side === 'up' ? '押涨' : '押跌'} $${b.stake} @${(b.cost * 100).toFixed(0)}¢ → ${b.pnl >= 0 ? '+' : ''}$${b.pnl.toFixed(0)}<br><span class="time">${formatTime(b.winStart)}期</span></div>`)
    .join('');

  const daily = wallet.dailyReturns(10);
  const dailyHtml = daily.length
    ? `<table class="sy-table"><thead><tr><th>日期</th><th>总资产</th><th>当日盈亏</th><th>收益率</th></tr></thead><tbody>` +
      daily
        .map((d) => `<tr><td>${d.dateLabel}</td><td>$${d.total.toFixed(0)}</td><td class="${d.pnl >= 0 ? 'up' : 'down'}">${d.pnl >= 0 ? '+' : ''}$${d.pnl.toFixed(1)}</td><td class="${(d.retPct ?? 0) >= 0 ? 'up' : 'down'}">${d.retPct !== null ? (d.retPct >= 0 ? '+' : '') + d.retPct.toFixed(2) + '%' : '-'}</td></tr>`)
        .join('') +
      `</tbody></table>`
    : '<div class="sy-note">运行满一天后开始每日复盘</div>';

  const hourly = wallet.hourlyReturns(12);
  const hourlyHtml = hourly.length
    ? hourly.map((h) => `<div class="rv-stat"><span>${formatTime(h.time)}</span><span class="${h.pnl >= 0 ? 'up' : 'down'}">${h.pnl >= 0 ? '+' : ''}$${h.pnl.toFixed(1)}${h.retPct !== null ? `（${h.retPct >= 0 ? '+' : ''}${h.retPct.toFixed(2)}%）` : ''}</span></div>`).join('')
    : '<div class="sy-note">每小时快照积累中…</div>';

  box.innerHTML =
    `<div class="wallet-summary">` +
    `<div class="w-total ${totalRet >= 0 ? 'up' : 'down'}">$${total.toFixed(1)} <small>${totalRet >= 0 ? '+' : ''}${totalRet.toFixed(2)}%</small></div>` +
    `<div class="sy-note">合约钱包 $${spotEq.toFixed(1)}（现金$${wallet.cash.toFixed(1)}） · PM钱包 $${pmEq.toFixed(1)}（现金$${wallet.pmCash.toFixed(1)}）</div>` +
    `<div class="sy-note">合约：${s.spotTrades}笔 胜率${pct(s.spotWinRate)} 净盈亏${s.spotNetPnl >= 0 ? '+' : ''}$${s.spotNetPnl.toFixed(1)} 手续费$${s.totalFees.toFixed(1)} · ` +
    `PM：${s.pmBets}注 胜率${pct(s.pmWinRate)} 净盈亏${s.pmNetPnl >= 0 ? '+' : ''}$${s.pmNetPnl.toFixed(1)}</div>` +
    `</div>` +
    `<div class="bt-htitle">当前持仓</div>` + posHtml + betsHtml +
    `<div class="bt-htitle" style="margin-top:8px">每日收益复盘</div>` + dailyHtml +
    `<details style="margin-top:6px"><summary class="tf-head"><span class="tf-name">每小时收益（近12小时）</span></summary>${hourlyHtml}</details>` +
    `<details style="margin-top:6px"><summary class="tf-head"><span class="tf-name">合约平仓历史</span></summary>${closedHtml || '<div class="sy-note">暂无</div>'}</details>` +
    `<details style="margin-top:6px"><summary class="tf-head"><span class="tf-name">PM注单历史</span></summary>${betHistHtml || '<div class="sy-note">暂无</div>'}</details>` +
    (state.usingMock
      ? `<div class="rv-reflect" style="margin-top:6px">⚠ 当前为离线模拟行情，自动交易已暂停（避免虚假价差污染绩效）；连接真实行情后自动恢复。</div>`
      : '') +
    `<div class="rv-reflect" style="margin-top:6px">规则：初始$10000合约+$1000 PM（可手动注资） · 单笔保证金$500-1000 · 杠杆20-100x按信号强度分档 · ` +
    `taker手续费0.05%/边 · 亏损95%强平（50x下反向1.9%即强平，止损严格执行） · 覆盖全部交易对（当前品种策略信号+其他品种强度≥4信号） · ` +
    `同品种同策略6小时冷却 · 最多3仓 · PM每期唯一决策$50-100按真实卖一价</div>`;
}

/** 每小时权益快照 */
function walletSnapshot() {
  const prices = {};
  if (state.candles.length) prices[state.symbol] = state.candles[state.candles.length - 1].close;
  wallet.snapshotEquity(Math.floor(Date.now() / 1000), prices);
}

// ---------------- 多品种后台信号监控（全交易对提示音） ----------------

const watcherState = { timer: null, running: false };

async function watchAllSymbols() {
  if (watcherState.running || state.usingMock) return;
  watcherState.running = true;
  try {
    // 只轮询非当前品种的加密品种（当前品种已有实时流；NDX轮询成本高且盘后无变化）
    const targets = SYMBOLS.filter((s) => s.id !== state.symbol && s.source !== 'stock');
    for (const sym of targets) {
      try {
        const candles = await fetchHistory(sym.id, state.interval, 160);
        if (candles.length < 60) continue;
        walletMark(sym.id, candles[candles.length - 1].close); // 持仓价格更新
        const ind = computeAll(candles);
        const signals = generateSignals(candles, ind);
        if (!signals.length) continue;
        const lastClosed = candles[candles.length - 2]?.time;
        const s = signals[signals.length - 1];
        if (s.time !== lastClosed) continue; // 只报最新收盘K线上的信号
        if (s.score < 3) continue; // 强度≥3才播报
        alerts.fireRisk({
          key: `watch|${sym.id}|${s.time}|${s.side}`,
          title: `${sym.label} ${s.side === 'buy' ? '买入' : '卖出'}信号（强度${s.score}）`,
          body: s.reasons.join('；'),
          kind: s.side,
        });
        // 其他交易对强信号（≥4）自动开仓：全品种参与
        if (s.score >= 4 && !state.usingMock) {
          const atrArr = ind.atr;
          const atrV = atrArr[atrArr.length - 1] ?? atrArr[atrArr.length - 2];
          if (atrV) {
            const entry = candles[candles.length - 1].close;
            const long = s.side === 'buy';
            const lev = Math.max(20, Math.min(100, Math.round(20 + (s.score - 4) * 20)));
            const res = wallet.openPosition({
              symbol: sym.id,
              side: long ? 'long' : 'short',
              price: entry,
              margin: 500,
              leverage: lev,
              stop: long ? entry - 1.5 * atrV : entry + 1.5 * atrV,
              target: long ? entry + 2.5 * atrV : entry - 2.5 * atrV,
              reason: `全品种监控 强度${s.score}信号：${s.reasons.slice(0, 2).join('；')}`,
              time: Math.floor(Date.now() / 1000),
              strategy: 'watch',
            });
            if (res && !res.rejected) {
              alerts.fireRisk({
                key: `walletopen|${res.id}`,
                title: `模拟钱包开仓：${sym.label} ${long ? '做多' : '做空'} ${lev}x`,
                body: `保证金$500 · 入场${entry.toFixed(2)}`,
                kind: long ? 'buy' : 'sell',
              });
              renderWalletTab();
            }
          }
        }
      } catch (_) {
        /* 单品种失败不影响其他 */
      }
    }
  } finally {
    watcherState.running = false;
  }
}

// ---------------- 历史回测 ----------------

let backtestRunning = false;

async function runBacktestPanel() {
  if (backtestRunning) return;
  backtestRunning = true;
  const box = $('backtestBox');
  box.innerHTML = '<div class="advisor-loading">回测中，正在拉取多周期历史K线并复现建议…</div>';

  const fetchCandles = async (interval, limit) => {
    if (state.usingMock) return generateMockHistory(interval, limit);
    try {
      return await fetchHistory(state.symbol, interval, limit);
    } catch (_) {
      return generateMockHistory(interval, limit);
    }
  };

  let bt;
  try {
    bt = await runBacktest(fetchCandles);
  } catch (_) {
    box.innerHTML = '<div class="advisor-loading">回测失败，请重试</div>';
    backtestRunning = false;
    return;
  }

  const symLabel = getSymbol(state.symbol).label;
  const pct = (x) => (x !== null ? (x * 100).toFixed(0) + '%' : 'N/A');

  const table =
    `<table class="sy-table"><thead><tr><th>周期</th><th>次数</th><th>命中率</th><th>累计收益</th><th>多/空</th></tr></thead><tbody>` +
    bt.horizons
      .map((h) => {
        if (!h.total)
          return `<tr><td>${h.label}</td><td colspan="4" class="sy-note">${h.error ? '数据不可用' : '无有效样本'}</td></tr>`;
        const cls = h.hitRate >= 0.55 ? 'up' : h.hitRate < 0.45 ? 'down' : '';
        const cumCls = h.cum >= 0 ? 'up' : 'down';
        return (
          `<tr><td><b>${h.label}</b></td><td>${h.total}</td>` +
          `<td class="${cls}">${pct(h.hitRate)}</td>` +
          `<td class="${cumCls}">${h.cum >= 0 ? '+' : ''}${h.cum.toFixed(1)}%</td>` +
          `<td>${h.longs}/${h.shorts}</td></tr>`
        );
      })
      .join('') +
    `</tbody></table>`;

  // 每个周期的代表性正确/错误案例（含当时理由）
  const caseHtml = bt.horizons
    .filter((h) => h.total)
    .map((h) => {
      const caseLine = (c, ok) =>
        `<details class="pm-hist-item"><summary><span class="${ok ? 'rv-hit' : 'rv-miss'}">${ok ? '✓正确' : '✗错误'}</span> ` +
        `${formatTime(c.time)} ${c.direction === 'up' ? '看多' : '看空'}（${c.score.toFixed(1)}分）→ ${c.changePct >= 0 ? '+' : ''}${c.changePct.toFixed(2)}%，跟随收益${c.ret >= 0 ? '+' : ''}${c.ret.toFixed(2)}%</summary>` +
        `<ul class="reasons-list">${c.reasons.map((r) => `<li>· ${escapeHtml(r)}</li>`).join('')}</ul>` +
        `<div class="sy-note">入场${c.entry.toFixed(2)} → 出场${c.exit.toFixed(2)}（持有至${formatTime(c.exitTime)}）</div></details>`;
      const wins = (h.cases.wins || []).map((c) => caseLine(c, true)).join('');
      const losses = (h.cases.losses || []).map((c) => caseLine(c, false)).join('');
      return (
        `<div class="bt-hgroup"><div class="bt-htitle">${h.label} 代表案例</div>` +
        (wins || losses || '<div class="sy-note">无</div>') +
        `</div>`
      );
    })
    .join('');

  const reflectHtml =
    `<div class="rv-reflect"><b>深刻反思与改进：</b><br>` +
    bt.reflections.map((r) => `· ${escapeHtml(r)}`).join('<br>') +
    `</div>`;

  box.innerHTML =
    `<div class="sy-note">标的 ${escapeHtml(symLabel)} · 回测于 ${formatTime(bt.generatedAt)}${state.usingMock ? ' · 模拟数据' : ''}</div>` +
    table +
    reflectHtml +
    `<div style="margin-top:6px"><b>代表案例（点击展开当时理由）</b></div>` +
    caseHtml;

  backtestRunning = false;
}

// ---------------- 侧栏Tab切换 ----------------

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document
      .querySelectorAll('.tab-page')
      .forEach((p) => p.classList.toggle('active', p.id === btn.dataset.tab));
    if (btn.dataset.tab === 'tabSerenity') {
      refreshSerenity(); // 懒加载股票行情
      if (!$('serenityFeedBox').dataset.loaded) {
        $('serenityFeedBox').dataset.loaded = '1';
        refreshSerenityFeed();
        setInterval(refreshSerenityFeed, 10 * 60 * 1000);
      }
    }
    if (btn.dataset.tab === 'tabBacktest' && !$('backtestBox').dataset.ran) {
      $('backtestBox').dataset.ran = '1';
      runBacktestPanel();
    }
  });
});

$('backtestRun').addEventListener('click', runBacktestPanel);

$('newsRefresh').addEventListener('click', refreshNews);

$('walletAddSpot').addEventListener('click', () => {
  const amt = prompt('增加多少合约虚拟资本（美元）？', '5000');
  if (amt === null) return;
  if (wallet.addFunds(amt, 'spot')) renderWalletTab();
  else alert('金额无效（需为0-1,000,000之间的数字）');
});

$('walletAddPm').addEventListener('click', () => {
  const amt = prompt('增加多少PM虚拟资本（美元）？', '1000');
  if (amt === null) return;
  if (wallet.addFunds(amt, 'pm')) renderWalletTab();
  else alert('金额无效（需为0-1,000,000之间的数字）');
});

$('walletReset').addEventListener('click', () => {
  if (!confirm('确认重置模拟钱包？将清空全部持仓、注单与收益记录。')) return;
  wallet.cash = 10000;
  wallet.pmCash = 1000;
  wallet.positions = [];
  wallet.closed = [];
  wallet.bets = [];
  wallet.settledBets = [];
  wallet.equity = [];
  wallet.lastEntry = {};
  wallet.createdAt = Math.floor(Date.now() / 1000);
  wallet._save();
  renderWalletTab();
});

// ---------------- 真实新闻抓取 ----------------

async function refreshNews() {
  const base = getSymbol(state.symbol).base;
  const statusEl = $('newsRefreshStatus');
  if (statusEl) statusEl.textContent = '刷新中…';
  try {
    state.newsEvents = await fetchNews(base);
    if (statusEl) statusEl.textContent = `已刷新 ${formatTime(Math.floor(Date.now() / 1000))} · 共${state.newsEvents.length}条（3天内）`;
  } catch (_) {
    state.newsEvents = [];
    if (statusEl) statusEl.textContent = '刷新失败，将自动重试';
  }
  renderMarkers();
  renderEventList();
}

// ---------------- KOL信号雷达 ----------------

async function refreshKolRadar() {
  const box = $('kolBox');
  if (!box) return;
  const items = await fetchKolSignals();
  const listHtml = items.length
    ? items
        .map(
          (x) =>
            `<div class="kol-item"><span class="bias ${x.bias}">${x.bias === 'bullish' ? '看多' : x.bias === 'bearish' ? '看空' : '中性'}</span>` +
            `<span class="kol-name">${escapeHtml(x.kol)}</span>` +
            `<a href="${escapeHtml(x.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(x.title)}</a>` +
            `<br><span class="time">${formatTime(x.time)} · <a href="${escapeHtml(x.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--muted)">${escapeHtml(x.handle)}</a></span></div>`
        )
        .join('')
    : '<div class="advisor-loading">暂无近期公开信号（或网络受限）</div>';

  const kolListHtml =
    `<details class="kol-list-note"><summary class="tf-head"><span class="tf-name">监控清单（10位）与说明</span></summary>` +
    `<div class="sy-note">${KOLS.map((k) => `${escapeHtml(k.name)}（${escapeHtml(k.handle)}·${escapeHtml(k.style)}）`).join('；')}</div>` +
    `<div class="sy-note" style="margin-top:4px">说明：X/Telegram的API需付费Key，本雷达通过公开新闻聚合捕捉这些KOL被报道/转载的最新观点，仅覆盖公开内容；` +
    `可自建代理接入实时推文（js/radar.js 的 fetchLiveSignals 钩子）。KOL观点不构成投资建议。</div></details>`;

  setHtmlIfChanged(box, listHtml + kolListHtml);
}

// ---------------- 交互绑定 ----------------

const symbolSelect = $('symbolSelect');
symbolSelect.innerHTML = SYMBOLS.map(
  (s) => `<option value="${s.id}">${s.label}</option>`
).join('');
symbolSelect.value = state.symbol;

symbolSelect.addEventListener('change', (e) => {
  state.symbol = e.target.value;
  loadSymbol();
});

$('intervalSelect').addEventListener('change', (e) => {
  state.interval = e.target.value;
  loadSymbol();
});

$('subIndicatorSelect').addEventListener('change', (e) => {
  state.subIndicator = e.target.value;
  renderSubIndicator();
});

$('toggleEvents').addEventListener('change', renderMarkers);
$('toggleSignals').addEventListener('change', renderMarkers);
$('toggleMute').addEventListener('change', (e) => {
  alerts.muted = e.target.checked;
});

$('advisorRefresh').addEventListener('click', refreshAdvisorAndVolume);

$('eventForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const timeStr = $('evtTime').value;
  const title = $('evtTitle').value.trim();
  if (!timeStr || !title) return;
  addCustomEvent({
    time: Math.floor(new Date(timeStr).getTime() / 1000),
    title,
    category: $('evtCategory').value,
    impact: $('evtImpact').value,
    note: $('evtNote').value.trim(),
  });
  e.target.reset();
  renderMarkers();
  renderEventList();
});

// ---------------- 启动 ----------------

alerts.requestPermission();
loadSymbol();

// 综合建议 + 成交量对比：每30分钟刷新
setInterval(refreshAdvisorAndVolume, 30 * 60 * 1000);
// 新闻：每5分钟刷新
setInterval(refreshNews, 5 * 60 * 1000);
// KOL信号雷达：立即 + 每10分钟（24小时不间断）
refreshKolRadar();
setInterval(refreshKolRadar, 10 * 60 * 1000);

// 版本门：旧部署强制引导到最新地址
(async () => {
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/crazyjohn25/crazyjohn25/cursor/tradingview-macro-signals-bd5c/data/version.json?t=${Date.now()}`
    );
    if (res.ok) {
      const remote = await res.json();
      if (remote && typeof remote.v === 'number' && remote.v > APP_VERSION) {
        $('versionGate').classList.remove('hidden');
      }
    }
  } catch (_) {
    /* 网络受限时不阻塞使用 */
  }
})();
// Polymarket 5m：每15秒刷新行情与建议；1分钟K线缓存每60秒刷新
setInterval(refreshPolymarket, 15 * 1000);
setInterval(refreshPm1mCandles, 60 * 1000);
// 复盘结算：每分钟检查一次到期预测
setInterval(() => {
  settleReviews();
  renderReviewPanel();
}, 60 * 1000);
// 全品种信号监控：每2分钟轮询其他交易对，有信号即提示音+通知
setInterval(watchAllSymbols, 2 * 60 * 1000);
// 模拟钱包：每5分钟检查快照（内部按小时去重），每分钟刷新面板浮盈
walletSnapshot();
setInterval(walletSnapshot, 5 * 60 * 1000);
setInterval(renderWalletTab, 60 * 1000);
