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
import { runAdvisor, TIMEFRAMES, TF_WEIGHTS } from './advisor.js';
import {
  currentWindowStart,
  fetchWindowMarket,
  fetchBook,
  fetchTrades,
  analyzeBook,
  analyzeTrades,
  advise5m,
} from './polymarket.js';
import { ReviewLog, adaptWeights } from './review.js';
import { interpret } from './interpret.js';
import {
  SERENITY_PICKS,
  INDUSTRIES,
  NARRATIVES,
  SERENITY_PROFILE,
  buildSerenityIndex,
  scorePick,
} from './serenity.js';
import { fetchDailyBatch } from './stocks.js';
import { PmHistory, pmDeepStats, pmReflections } from './pmstats.js';
import { lastStockSource } from './datafeed.js';

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

/** Polymarket 5m 状态（仅BTC品种启用） */
const pm = {
  window: null, // fetchWindowMarket 结果
  strike: null, // 窗口开始价（以币安1m开盘价近似Chainlink）
  advice: null,
  flow: null,
  bookInfo: null,
  candles1m: [], // 独立的BTC 1分钟K线缓存
  priceLine: null,
  lastRecordWindow: null,
};

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

  const lastTime = candles[candles.length - 1].time;
  alerts.check(
    state.signals.filter((s) => s.time < lastTime),
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

async function refreshAdvisorAndVolume() {
  const box = $('advisorBox');
  box.innerHTML = '<div class="advisor-loading">分析中…</div>';

  const fetchCandles = async (tf) => {
    if (state.usingMock) return generateMockHistory(tf, 400);
    const c = await fetchHistory(state.symbol, tf, 400);
    if (tf === '1h') state.candles1h = c;
    return c;
  };

  // 复盘：先结算到期预测，再用自适应权重出新建议
  settleReviews();
  const { weights, reflections } = adaptWeights(reviewLog.stats(), TF_WEIGHTS);
  state.reflections = reflections;

  try {
    state.advice = await runAdvisor(fetchCandles, { weights });
  } catch (_) {
    state.advice = null;
  }
  if (state.usingMock) state.candles1h = generateMockHistory('1h', 400);

  recordAdvisorPredictions();
  renderAdvisor();
  renderVolumePanel();
  renderReviewPanel();
}

// ---------------- 建议复盘：登记、结算、反思 ----------------

const TF_HORIZON = { '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400 };

/** 登记本轮综合建议的各周期预测（到期后与实际对照） */
function recordAdvisorPredictions() {
  const adv = state.advice;
  if (!adv || state.usingMock) return;
  const now = Math.floor(Date.now() / 1000);
  const price = state.candles.length ? state.candles[state.candles.length - 1].close : null;
  if (!price) return;
  for (const tf of TIMEFRAMES) {
    const r = adv.perTf[tf];
    if (!r || r.verdict === '数据不足') continue;
    const direction = r.score >= 0.75 ? 'up' : r.score <= -0.75 ? 'down' : 'flat';
    if (direction === 'flat') continue; // 只复盘有方向的判断
    reviewLog.record({
      source: `advisor:${tf}`,
      symbol: state.symbol,
      direction,
      priceAtCall: price,
      callTime: now,
      evalTime: now + TF_HORIZON[tf],
      note: r.verdict,
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

  const SRC_LABEL = (s) =>
    s.startsWith('advisor:') ? `综合建议 ${s.split(':')[1]}` : s === 'polymarket:5m' ? 'PM 5分钟' : s;

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

function verdictClass(score) {
  if (score >= 1) return 'bull';
  if (score <= -1) return 'bear';
  return 'flat';
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
  const tfRows = TIMEFRAMES.map((tf) => {
    const r = adv.perTf[tf];
    if (!r) return '';
    const cls = verdictClass(r.score);
    const reasons = r.reasons.map((x) => `<li>${escapeHtml(x)}</li>`).join('');
    return (
      `<details class="tf-row"><summary class="tf-head">` +
      `<span class="tf-name">${tf}</span>` +
      `<span class="tf-verdict ${cls}">${escapeHtml(r.verdict)}（${r.score.toFixed(1)}分）</span>` +
      `</summary><ul class="tf-reasons">${reasons}</ul></details>`
    );
  }).join('');

  const planHtml = adv.plan
    ? `<div class="plan"><b>交易计划（${adv.plan.direction === 'long' ? '做多' : '做空'}）</b><br>` +
      `入场 ${adv.plan.entry.toFixed(1)} · 止损 ${adv.plan.stop.toFixed(1)} · 目标 ${adv.plan.target.toFixed(1)}` +
      (adv.plan.rr ? ` · 盈亏比 1:${adv.plan.rr.toFixed(1)}` : '') +
      `<br>${escapeHtml(adv.plan.note)}</div>`
    : '';

  box.innerHTML =
    `<span class="action ${actionClass(adv.action)}">${escapeHtml(adv.action)}</span>` +
    `<span class="upd"> 更新于 ${formatTime(adv.updatedAt)}${state.usingMock ? '（模拟数据）' : ''}</span>` +
    `<div class="summary">${escapeHtml(adv.summary)}</div>` +
    planHtml +
    tfRows;
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

    // 订单簿 + 成交流
    const [book, trades] = await Promise.all([
      pm.window.upTokenId ? fetchBook(pm.window.upTokenId) : null,
      pm.window.conditionId ? fetchTrades(pm.window.conditionId, 100) : [],
    ]);
    pm.bookInfo = book ? analyzeBook(book) : null;
    // 只统计本窗口内的成交
    pm.flow = analyzeTrades(trades.filter((t) => Number(t.timestamp) >= winStart));

    const secondsLeft = Math.max(0, pm.window.endSec - Math.floor(Date.now() / 1000));
    pm.advice = advise5m({
      candles1m: pm.candles1m,
      strikePrice: pm.strike,
      upPrice: pm.window.upPrice,
      flow: pm.flow,
      book: pm.bookInfo,
      secondsLeft,
    });

    // 复盘登记：每窗口只记一次有方向的建议
    if (
      (pm.advice.action === '买Up' || pm.advice.action === '买Down') &&
      pm.lastRecordWindow !== winStart &&
      pm.candles1m.length
    ) {
      pm.lastRecordWindow = winStart;
      reviewLog.record({
        source: 'polymarket:5m',
        symbol: 'BTCUSDT',
        direction: pm.advice.action === '买Up' ? 'up' : 'down',
        priceAtCall: pm.strike ?? pm.candles1m[pm.candles1m.length - 1].close,
        callTime: Math.floor(Date.now() / 1000),
        evalTime: pm.window.endSec,
        note: `edge=${(pm.advice.edge * 100).toFixed(1)}分`,
      });
    }

    // 5分钟历史快照：每窗口登记完整推理依据（含观望，供回滚查看）
    if (pm.strike && pm.candles1m.length) {
      const cur = pm.candles1m[pm.candles1m.length - 1].close;
      pmHistory.record({
        winStart,
        winEnd: pm.window.endSec,
        action: pm.advice.action,
        edge: pm.advice.edge,
        techProb: pm.advice.techProb,
        strike: pm.strike,
        priceAtCall: cur,
        secondsLeftAtCall: secondsLeft,
        leadPct: ((cur - pm.strike) / pm.strike) * 100,
        flowBias:
          pm.flow && pm.flow.upFlow + pm.flow.downFlow > 0
            ? pm.flow.netUpFlow / (pm.flow.upFlow + pm.flow.downFlow)
            : null,
        bookImbalance: pm.bookInfo ? pm.bookInfo.imbalance : null,
        upPrice: pm.window.upPrice,
        reasons: pm.advice.reasons,
      });
    }
    settlePmHistory();

    renderPmPanel(secondsLeft);
    renderPmStats();
    updateStrikeLine();
  } catch (_) {
    setHtmlIfChanged($('pmBox'), '<div class="advisor-loading">Polymarket数据获取失败，将自动重试</div>');
  }
}

/** 结算5分钟历史：用1分钟K线还原窗口结束价 */
function settlePmHistory() {
  if (!pm.candles1m.length) return;
  pmHistory.settle((timeSec) => {
    // 窗口结束价 = 覆盖该时刻的1分钟K线收盘价
    for (let i = pm.candles1m.length - 1; i >= 0; i--) {
      const c = pm.candles1m[i];
      if (c.time <= timeSec - 60) return c.close; // 结束前最后一根完整1m线
    }
    return null;
  });
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
      return (
        `<details class="pm-hist-item"><summary><span class="${cls}">${r.hit ? '✓' : '✗'}</span> ` +
        `${formatTime(r.winStart)} ${escapeHtml(r.action)}（edge ${(r.edge * 100).toFixed(1)}分）→ 实际${r.outcome === 'up' ? '涨' : '跌'}</summary>` +
        `<ul class="reasons-list">${(r.reasons || []).map((x) => `<li>· ${escapeHtml(x)}</li>`).join('')}</ul>` +
        `<div class="sy-note">目标价${r.strike.toFixed(1)} · 下单价${r.priceAtCall.toFixed(1)} · 结束价${r.endPrice ? r.endPrice.toFixed(1) : '-'}</div>` +
        missNote +
        `</details>`
      );
    })
    .join('');

  setHtmlIfChanged(
    box,
    `<div class="rv-stat"><span>累计方向预测</span><span>${stats.total}次</span></div>` +
      `<div class="rv-stat"><span>命中率</span><span class="rv-rate ${stats.hitRate >= 0.55 ? 'good' : stats.hitRate < 0.45 ? 'bad' : ''}">${pct(stats.hitRate)}</span></div>` +
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

  setHtmlIfChanged(
    $('pmBox'),
    `<div class="pm-q">${escapeHtml(w.question)} · <a href="${escapeHtml(w.url)}" target="_blank" rel="noopener noreferrer">开市场↗</a></div>` +
      `<div class="pm-odds">` +
      `<div class="pm-odd up">${w.upPrice !== null ? (w.upPrice * 100).toFixed(0) + '¢' : '-'}<small>Up 隐含概率</small></div>` +
      `<div class="pm-odd down">${w.downPrice !== null ? (w.downPrice * 100).toFixed(0) + '¢' : '-'}<small>Down 隐含概率</small></div>` +
      `</div>` +
      (pm.strike
        ? `<div class="pm-strike">🎯 目标价 ${pm.strike.toFixed(1)}（已画到K线图，币安1m开盘价近似Chainlink）</div>`
        : `<div class="pm-strike">目标价待窗口起始K线生成…</div>`) +
      `<span class="pm-action ${actionCls}">${escapeHtml(a.action)}</span>` +
      (a.edge ? `<span class="upd"> 期望优势 ${(a.edge * 100).toFixed(1)}分</span>` : '') +
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
  let daily = {};
  try {
    daily = await fetchDailyBatch(tickers);
  } catch (_) {
    /* 全部失败时 daily 为空，下面各自降级 */
  }

  // 指数
  const idx = buildSerenityIndex(daily);
  const idxBox = $('serenityIndexBox');
  if (idx) {
    const cls = idx.changePct >= 0 ? 'up' : 'down';
    const spark = idx.series
      .map((p, i) => (i % Math.ceil(idx.series.length / 20) === 0 ? p.value.toFixed(1) : null))
      .filter(Boolean)
      .join(' → ');
    idxBox.innerHTML =
      `<span class="sy-idx ${cls}">${idx.current.toFixed(2)}</span> ` +
      `<span class="rv-rate ${cls === 'up' ? 'good' : 'bad'}">${idx.changePct >= 0 ? '+' : ''}${idx.changePct.toFixed(2)}% / 30天</span>` +
      `<div class="sy-note">覆盖${idx.covered}/${idx.total}只成分 · 等权重 · 基期=100` +
      `${lastStockSource === 'snapshot' ? ' · 快照数据（实时源不可达）' : ''}</div>` +
      `<div class="sy-note">走势：${spark}</div>`;
  } else {
    idxBox.innerHTML = '<div class="advisor-loading">行情不可用，无法合成指数</div>';
  }

  // 组合表（按评分排序）
  const rows = SERENITY_PICKS.map((p) => {
    const d = daily[p.ticker];
    const { score, perf30 } = scorePick(p, d ? d.candles : null);
    return { ...p, score, perf30 };
  }).sort((a, b) => b.score - a.score);

  $('serenityPicksBox').innerHTML =
    `<table class="sy-table"><thead><tr><th>标的</th><th>行业</th><th>叙事</th><th>30天</th><th>评分</th></tr></thead><tbody>` +
    rows
      .map((r) => {
        const ind = INDUSTRIES[r.industry];
        const perfCls = r.perf30 === null ? '' : r.perf30 >= 0 ? 'up' : 'down';
        return (
          `<tr><td><b>${escapeHtml(r.ticker)}</b>${r.disclosed ? ' ◆' : ''}</td>` +
          `<td><span class="sy-tag" style="background:${ind.color}">${ind.label}</span></td>` +
          `<td>${NARRATIVES[r.narrative].label}</td>` +
          `<td class="${perfCls}">${r.perf30 === null ? '-' : (r.perf30 >= 0 ? '+' : '') + r.perf30.toFixed(1) + '%'}</td>` +
          `<td class="sy-score">${r.score.toFixed(1)}</td></tr>` +
          `<tr><td colspan="5" class="sy-note">${escapeHtml(r.note)}</td></tr>`
        );
      })
      .join('') +
    `</tbody></table>` +
    `<div class="sy-note" style="margin-top:4px">◆=本人公开披露持仓 · 评分=叙事权重×2 + 30天动量 + 披露加成（0-10）</div>`;

  // 方法论
  const pr = SERENITY_PROFILE;
  $('serenityProfileBox').innerHTML =
    `<div class="rv-stat"><span>账号</span><span><a href="${pr.url}" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">${pr.handle}</a>（${pr.followers}粉丝）</span></div>` +
    `<div class="rv-stat"><span>风格</span><span>${escapeHtml(pr.style)}</span></div>` +
    `<div class="interp"><b>核心框架：</b>${escapeHtml(pr.framework)}</div>` +
    `<div class="interp"><b>代表战绩：</b>${escapeHtml(pr.record)}</div>` +
    `<div class="rv-reflect">${escapeHtml(pr.risk)}</div>`;
}

// ---------------- 侧栏Tab切换 ----------------

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document
      .querySelectorAll('.tab-page')
      .forEach((p) => p.classList.toggle('active', p.id === btn.dataset.tab));
    if (btn.dataset.tab === 'tabSerenity') refreshSerenity(); // 懒加载股票行情
  });
});

// ---------------- 真实新闻抓取 ----------------

async function refreshNews() {
  const base = getSymbol(state.symbol).base;
  try {
    state.newsEvents = await fetchNews(base);
  } catch (_) {
    state.newsEvents = [];
  }
  renderMarkers();
  renderEventList();
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
// Polymarket 5m：每15秒刷新行情与建议；1分钟K线缓存每60秒刷新
setInterval(refreshPolymarket, 15 * 1000);
setInterval(refreshPm1mCandles, 60 * 1000);
// 复盘结算：每分钟检查一次到期预测
setInterval(() => {
  settleReviews();
  renderReviewPanel();
}, 60 * 1000);
