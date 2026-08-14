/**
 * 页面主逻辑：图表渲染、实时数据、指标叠加、事件标注、信号报警、
 * 三层策略建议、分析报告存档、每日两次复盘、模拟交易钱包、AI交易复盘、
 * 做市商Gamma环境、KOL雷达、Serenity跟踪
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
import { runAdvisor, STRATEGIES, MAJOR_THRESHOLD } from './advisor.js';
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
import { getAssetInfo } from './assets.js';
import { fetchGex, explainGex } from './gamma.js';
import { PaperWallet, leverageFromScore } from './wallet.js';
import { ReportArchive, generateReport, generateDailyReview } from './report.js';
import { SignalArchive } from './archive.js';
import { getSettings, saveSettings } from './settings.js';
import { notifyExternal, sendTelegram, sendEmail } from './notify.js';
import { getKolList, fetchKolSignals } from './radar.js';

/** 版本号：与 data/version.json 同步，旧部署会被远端更高版本强制引导到最新地址 */
const APP_VERSION = 14;

const $ = (id) => document.getElementById(id);

const SUB_LABELS = {
  rsi: 'RSI(14) — 相对强弱指标',
  kdj: 'KDJ(9,3,3) — 随机指标',
  stoch: '平滑STOCH(14,6,6) — 圆弧随机指标',
  wae: 'WAE动能爆发 — 动量柱vs爆发线',
  dmi: 'DMI(14) — 动向指标（+DI/-DI/ADX）',
  obv: 'OBV — 能量潮（累计成交量）',
};

const state = {
  symbol: 'BTCUSDT',
  interval: '1h',
  candles: [],
  candles1h: [],
  indicators: null,
  signals: [],
  anomalies: [],
  newsEvents: [],
  advice: null,
  gamma: null,
  unsubscribe: null,
  unsubWhale: null,
  usingMock: false,
  subIndicator: 'rsi',
  reflections: [],
};

const settings = getSettings();
const alerts = new AlertManager({ onAlert: showToast });
const whaleFeed = new WhaleFeed(30);
const reviewLog = new ReviewLog();
const wallet = new PaperWallet({ initialCapital: settings.initialCapital });
const reports = new ReportArchive();
const signalArchive = new SignalArchive();

/** 高置信事件统一外发：页面toast+提示音+浏览器通知+Telegram/邮箱 */
function pushAlert({ key, title, body, kind = 'risk', external = false }) {
  alerts.fireRisk({ key, title, body, kind });
  if (external) notifyExternal(title, body).catch(() => {});
}

// ---------------- 图表初始化（浅色主题） ----------------

function chartTickUTC8(t, tickType) {
  const d = new Date((t + 8 * 3600) * 1000);
  const pad = (x) => String(x).padStart(2, '0');
  if (tickType === 0) return String(d.getUTCFullYear());
  if (tickType === 1 || tickType === 2) return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

const chartOpts = {
  layout: { background: { color: '#ffffff' }, textColor: '#4a5568' },
  grid: {
    vertLines: { color: 'rgba(221,227,236,.6)' },
    horzLines: { color: 'rgba(221,227,236,.6)' },
  },
  timeScale: {
    timeVisible: true,
    secondsVisible: false,
    borderColor: '#dde3ec',
    tickMarkFormatter: chartTickUTC8,
  },
  localization: { timeFormatter: (t) => `${formatTime(t)} (UTC+8)` },
  rightPriceScale: { borderColor: '#dde3ec' },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  autoSize: true,
};

const mainChart = LightweightCharts.createChart($('mainChart'), chartOpts);
const macdChart = LightweightCharts.createChart($('macdChart'), chartOpts);
const subChart = LightweightCharts.createChart($('subChart'), chartOpts);

const candleSeries = mainChart.addCandlestickSeries({
  upColor: '#0e9f6e',
  downColor: '#e02424',
  wickUpColor: '#0e9f6e',
  wickDownColor: '#e02424',
  borderVisible: false,
});
const bollUpper = mainChart.addLineSeries({ color: 'rgba(37,99,235,.6)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
const bollMiddle = mainChart.addLineSeries({ color: 'rgba(217,119,6,.8)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
const bollLower = mainChart.addLineSeries({ color: 'rgba(37,99,235,.6)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

const emaFastLine = mainChart.addLineSeries({ color: '#eab308', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
const emaMidLine = mainChart.addLineSeries({ color: '#2563eb', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
const emaSlowLine = mainChart.addLineSeries({ color: '#dc2626', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });

const volumeSeries = mainChart.addHistogramSeries({
  priceFormat: { type: 'volume' },
  priceScaleId: 'vol',
  priceLineVisible: false,
  lastValueVisible: false,
});
mainChart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

const macdHist = macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
const macdDif = macdChart.addLineSeries({ color: '#d97706', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
const macdDea = macdChart.addLineSeries({ color: '#2563eb', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

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
  if (state.unsubscribe) { state.unsubscribe(); state.unsubscribe = null; }
  if (state.unsubWhale) { state.unsubWhale(); state.unsubWhale = null; }
  whaleFeed.clear();
  alerts.reset();
  setStatus('加载历史K线…', '');

  try {
    const candles = await fetchHistory(state.symbol, state.interval, 500);
    if (token !== loadToken) return;
    state.candles = candles;
    state.usingMock = false;
    state.unsubscribe = subscribeKline(state.symbol, state.interval, onRealtimeBar,
      () => setStatus('行情连接异常，自动重连中', 'err'));
    state.unsubWhale = subscribeWhaleTrades(state.symbol, onWhaleTrade);
    setStatus(`已连接 · ${getSymbol(state.symbol).label}`, 'ok');
  } catch (err) {
    if (token !== loadToken) return;
    state.candles = generateMockHistory(state.interval, 500);
    state.usingMock = true;
    setStatus('离线模式（模拟行情演示）', 'err');
    state.unsubscribe = subscribeMockKline(state.interval, state.candles[state.candles.length - 1], onRealtimeBar);
  }

  recomputeAndRender({ fitContent: true });
  refreshAdvisorAndVolume();
  refreshNews();
  refreshGamma();
  renderAssetInfo();
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

  candleSeries.update(bar);
  volumeSeries.update({
    time: bar.time,
    value: bar.volume,
    color: bar.close >= bar.open ? 'rgba(14,159,110,.4)' : 'rgba(224,36,36,.4)',
  });
  walletMark(state.symbol, bar.close);
  renderQuoteBar();

  const now = Date.now();
  if (isClosed || now - lastFullRender > 5000) {
    lastFullRender = now;
    recomputeAndRender({ fitContent: false });
  }
}

let whaleRenderQueued = false;
function onWhaleTrade(trade) {
  whaleFeed.push(trade);
  if (whaleRenderQueued) return;
  whaleRenderQueued = true;
  setTimeout(() => { whaleRenderQueued = false; renderWhaleList(); }, 1000);
}

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
      pushAlert({
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
      color: c.close >= c.open ? 'rgba(14,159,110,.4)' : 'rgba(224,36,36,.4)',
    }))
  );

  const toLine = (arr) =>
    candles.map((c, i) => (arr[i] !== null ? { time: c.time, value: arr[i] } : null)).filter(Boolean);

  const { boll, macd } = state.indicators;
  bollUpper.setData(toLine(boll.upper));
  bollMiddle.setData(toLine(boll.middle));
  bollLower.setData(toLine(boll.lower));
  emaFastLine.setData(toLine(state.indicators.ema10));
  emaMidLine.setData(toLine(state.indicators.ema30));
  emaSlowLine.setData(toLine(state.indicators.ema60));

  macdDif.setData(toLine(macd.dif));
  macdDea.setData(toLine(macd.dea));
  macdHist.setData(
    candles.map((c, i) =>
      macd.hist[i] !== null
        ? { time: c.time, value: macd.hist[i], color: macd.hist[i] >= 0 ? 'rgba(14,159,110,.7)' : 'rgba(224,36,36,.7)' }
        : null
    ).filter(Boolean)
  );

  renderSubIndicator();
  renderMarkers();
  renderQuoteBar();
  renderSignalList();
  renderAnomalyList();
  renderEventList();

  const lastTime = candles[candles.length - 1].time;
  alerts.check(state.signals.filter((s) => s.time < lastTime && s.score >= 3), state.symbol);

  if (fitContent) mainChart.timeScale().fitContent();
}

const SUB_INDICATOR_LINES = {
  rsi: [{ color: '#d97706', pick: (ind) => ind.rsi }],
  kdj: [
    { color: '#d97706', pick: (ind) => ind.kdj.k },
    { color: '#2563eb', pick: (ind) => ind.kdj.d },
    { color: '#ea580c', pick: (ind) => ind.kdj.j },
  ],
  stoch: [
    { color: '#2563eb', width: 2, pick: (ind) => ind.stoch.k },
    { color: '#dc2626', pick: (ind) => ind.stoch.d },
  ],
  wae: [
    { type: 'hist', pick: (ind) => ind.wae.momentum },
    { color: '#d97706', pick: (ind) => ind.wae.explosion },
  ],
  dmi: [
    { color: '#0e9f6e', pick: (ind) => ind.dmi.pdi },
    { color: '#e02424', pick: (ind) => ind.dmi.mdi },
    { color: '#d97706', pick: (ind) => ind.dmi.adx },
  ],
  obv: [{ color: '#7c3aed', pick: (ind) => ind.obv }],
};

function renderSubIndicator() {
  const candles = state.candles;
  const ind = state.indicators;
  const lines = SUB_INDICATOR_LINES[state.subIndicator];
  if (!lines || !ind) return;

  if (subSeriesType !== state.subIndicator) {
    for (const s of subSeries) subChart.removeSeries(s);
    subSeries = lines.map((l) =>
      l.type === 'hist'
        ? subChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false })
        : subChart.addLineSeries({ color: l.color, lineWidth: l.width || 1, priceLineVisible: false, lastValueVisible: false })
    );
    subSeriesType = state.subIndicator;
    $('subLabel').textContent = SUB_LABELS[state.subIndicator];
  }

  lines.forEach((l, idx) => {
    const arr = l.pick(ind);
    if (l.type === 'hist') {
      subSeries[idx].setData(
        candles.map((c, i) =>
          arr[i] !== null
            ? { time: c.time, value: Math.abs(arr[i]), color: arr[i] >= 0 ? 'rgba(14,159,110,.75)' : 'rgba(224,36,36,.75)' }
            : null
        ).filter(Boolean)
      );
    } else {
      subSeries[idx].setData(candles.map((c, i) => (arr[i] !== null ? { time: c.time, value: arr[i] } : null)).filter(Boolean));
    }
  });
}

// ---------------- 综合建议 + 成交量对比（每30分钟刷新） ----------------

function computeNewsBias() {
  const now = Math.floor(Date.now() / 1000);
  let sum = 0, bull = 0, bear = 0;
  for (const e of state.newsEvents || []) {
    if (now - e.time > 86400) continue;
    const it = interpret(e.title);
    const w = e.impact === 'high' ? 1 : 0.4;
    if (it.bias === 'bullish') { sum += w; bull++; }
    else if (it.bias === 'bearish') { sum -= w; bear++; }
  }
  if (bull + bear === 0) return null;
  const score = Math.tanh(sum / 4);
  return { score, reason: `新闻面（24h）：利好${bull}条 vs 利空${bear}条，净偏向${score >= 0 ? '偏多' : '偏空'}（${(score * 100).toFixed(0)}%权重按周期递减）` };
}

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
  handleMajorSignals();
  archiveReport();
  renderAdvisor();
  renderVolumePanel();
  renderReviewPanel();
  renderWalletTab();
  renderAiReview();
}

// ---------------- 建议复盘：登记、结算、反思 ----------------

function recordAdvisorPredictions() {
  const adv = state.advice;
  if (!adv || state.usingMock) return;
  const now = Math.floor(Date.now() / 1000);
  const price = state.candles.length ? state.candles[state.candles.length - 1].close : null;
  if (!price) return;
  for (const st of adv.strategies) {
    if (!st.major || st.action === '观望' || st.action === '数据不足') continue;
    reviewLog.record({
      source: `advisor:${st.key}`,
      symbol: state.symbol,
      direction: st.score > 0 ? 'up' : 'down',
      priceAtCall: price,
      callTime: now,
      evalTime: now + st.holdSec,
      note: st.action,
    });
  }
  const majors = adv.strategies.filter((s) => s.major);
  if (majors.length) {
    const avg = majors.reduce((s, x) => s + x.score, 0) / majors.length;
    reviewLog.record({
      source: 'advisor:daily',
      symbol: state.symbol,
      direction: avg > 0 ? 'up' : 'down',
      priceAtCall: price,
      callTime: now,
      evalTime: now + 86400,
      note: `日度综合（强烈信号均分${avg.toFixed(1)}）`,
    });
  }
}

function handleMajorSignals() {
  const adv = state.advice;
  if (!adv || !state.candles.length) return;
  if (state.usingMock) {
    renderArchive();
    return;
  }
  const price = state.candles[state.candles.length - 1].close;
  const now = Math.floor(Date.now() / 1000);
  for (const st of adv.strategies) {
    if (!st.major || !st.plan) continue;
    if (st.plan.rr !== null && st.plan.rr < 1) continue;
    const rec = signalArchive.consider({
      symbol: state.symbol,
      strategy: st.key,
      side: st.plan.direction,
      score: st.score,
      action: st.action,
      label: st.label,
      price,
      plan: st.plan,
      reasons: st.reasons.slice(0, 5),
      time: now,
    });
    if (!rec) continue;
    const lev = leverageFromScore(Math.abs(st.score), MAJOR_THRESHOLD);
    pushAlert({
      key: `major|${rec.fingerprint}|${rec.id}`,
      title: `⚡强烈信号 ${getSymbol(state.symbol).label} ${st.label}：${st.action}`,
      body: `评分${st.score.toFixed(1)} · 建议杠杆${lev}x` + (st.plan ? ` · 入场${st.plan.entry.toFixed(1)} 止损${st.plan.stop.toFixed(1)} 目标${st.plan.target.toFixed(1)}` : ''),
      kind: st.score > 0 ? 'buy' : 'sell',
      external: true,
    });
    const res = wallet.openPosition({
      symbol: state.symbol,
      side: st.plan.direction,
      price,
      margin: 500,
      leverage: lev,
      stop: st.plan.stop,
      target: st.plan.target,
      reason: `${st.label} ${st.action}（评分${st.score.toFixed(1)}）`,
      time: now,
      strategy: st.key,
    });
    if (res && !res.rejected) {
      pushAlert({
        key: `walletopen|${res.id}`,
        title: `模拟钱包开仓：${getSymbol(state.symbol).label} ${st.plan.direction === 'long' ? '做多' : '做空'} ${lev}x`,
        body: `保证金$500 · 入场${price.toFixed(1)} · 止损${st.plan.stop.toFixed(1)} · 目标${st.plan.target.toFixed(1)} · 开仓费$${(res.openFee || 0).toFixed(2)}（币安taker 0.05%）\n理由：${st.reasons.slice(0, 3).join('；')}`,
        kind: st.plan.direction === 'long' ? 'buy' : 'sell',
        external: true,
      });
      renderWalletTab();
      renderAiReview();
    }
  }
  renderArchive();
}

function renderArchive() {
  const box = $('archiveBox');
  if (!box) return;
  const items = signalArchive.recent(12);
  if (!items.length) {
    setHtmlIfChanged(box, '<div class="advisor-loading">暂无强烈信号。弱信号不会刷屏，只有多指标共振才会存档并跟单。</div>');
    return;
  }
  setHtmlIfChanged(
    box,
    items
      .map((r) => {
        const sideCls = r.side === 'long' ? 'bullish' : 'bearish';
        const plan = r.plan
          ? `<div class="plan">入场 ${Number(r.plan.entry).toFixed(1)} · 止损 ${Number(r.plan.stop).toFixed(1)} · 目标 ${Number(r.plan.target).toFixed(1)}` +
            (r.plan.rr ? ` · 盈亏比 1:${Number(r.plan.rr).toFixed(1)}` : '') +
            ` · ≤${r.plan.leverage || 30}x</div>`
          : '';
        return (
          `<div class="arch-item">` +
          `<div class="arch-head"><span>${escapeHtml(r.symbol)} · ${escapeHtml(r.label)}</span>` +
          `<span class="bias ${sideCls}">${escapeHtml(r.action || (r.side === 'long' ? '做多' : '做空'))}</span></div>` +
          `<div class="sy-note">评分 ${Number(r.score).toFixed(1)} · ${formatTime(r.time)}${r.price ? ` · 价${Number(r.price).toFixed(1)}` : ''}</div>` +
          plan +
          `</div>`
        );
      })
      .join('')
  );
}

function priceAt(symbol, timeSec) {
  const pools = [];
  if (symbol === state.symbol && state.candles.length) pools.push(state.candles);
  if (symbol === state.symbol && state.candles1h.length) pools.push(state.candles1h);
  for (const candles of pools) {
    if (candles[candles.length - 1].time < timeSec) continue;
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
    setHtmlIfChanged(box, `<div class="advisor-loading">暂无已结算的预测${pending ? `（${pending}条待结算）` : ''}</div>`);
    return;
  }

  const STRATEGY_NAMES = { short: '短线1-6h', mid: '中短线6-24h', long: '长线1-3天', daily: '综合·1天复盘' };
  const SRC_LABEL = (s) => (s.startsWith('advisor:') ? `建议·${STRATEGY_NAMES[s.split(':')[1]] || s.split(':')[1]}` : s);

  const statHtml = entries
    .map(([src, s]) => {
      const pct = s.hitRate !== null ? (s.hitRate * 100).toFixed(0) : '-';
      const cls = s.hitRate >= 0.55 ? 'good' : s.hitRate < 0.45 ? 'bad' : '';
      return `<div class="rv-stat"><span>${SRC_LABEL(src)}</span><span class="rv-rate ${cls}">${s.hits}/${s.total} 命中 ${pct}%</span></div>`;
    })
    .join('');

  const reflectHtml = state.reflections && state.reflections.length
    ? `<div class="rv-reflect">反思：${state.reflections.map(escapeHtml).join('；')}</div>`
    : '';

  const recentHtml = recent
    .map((r) =>
      `<div class="rv-item"><span class="rv-${r.outcome}">${r.outcome === 'hit' ? '✓' : '✗'}</span> ` +
      `${SRC_LABEL(r.source)} 预测${r.direction === 'up' ? '涨' : '跌'} → 实际${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(2)}%` +
      `<br><span class="time">${formatTime(r.callTime)} 判定于 ${formatTime(r.evalTime)}</span></div>`
    )
    .join('');

  setHtmlIfChanged(box, statHtml + reflectHtml + recentHtml + (pending ? `<div class="rv-item">另有 ${pending} 条预测待结算</div>` : ''));
}

function actionClass(action) {
  if (action.includes('买') || action.includes('多')) return 'buy';
  if (action.includes('卖') || action.includes('减') || action.includes('空')) return 'sell';
  return 'hold';
}

function renderAdvisor() {
  const box = $('advisorBox');
  const adv = state.advice;
  if (!adv) {
    box.innerHTML = '<div class="advisor-loading">分析失败，请点击下方按钮重试</div>';
    return;
  }

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
        `<div class="st-card ${st.major ? 'major' : 'weak'}">` +
        `<div class="st-head"><span class="st-label">${st.major ? '🔔 ' : ''}${escapeHtml(st.label)}</span>` +
        `<span class="action ${actionClass(st.action)}">${escapeHtml(st.action)}</span></div>` +
        `<div class="sy-note">评分 ${st.score.toFixed(1)} · 置信度 ${(st.conf * 100).toFixed(0)}%${st.major ? ' · 将存档并跟单' : ' · 未达强烈阈值，不播报不开仓'}</div>` +
        planHtml +
        `<details class="tf-row"><summary class="tf-head"><span class="tf-name">推理依据（${st.reasons.length}条）</span></summary>` +
        `<ul class="tf-reasons">${reasons}</ul></details>` +
        `</div>`
      );
    })
    .join('');

  box.innerHTML =
    `<span class="upd">更新于 ${formatTime(adv.updatedAt)}${state.usingMock ? '（模拟数据，自动开仓已暂停）' : ''} · 仅 |评分|≥${MAJOR_THRESHOLD} 的强烈信号会存档、提醒并模拟开仓</span>` +
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
      const d = new Date((r.time + 8 * 3600) * 1000);
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const pctCell = (v) =>
        v === null ? '<td>-</td>' : `<td class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : ''}${v.toFixed(0)}%</td>`;
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
  const html = recent.length === 0
    ? '<li class="reasons">当前周期暂无量价异动</li>'
    : recent
        .map((a) =>
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
    .map((t) =>
      `<li><span class="whale-${t.side}">${t.side === 'buy' ? '⬆ 大额买入' : '⬇ 大额卖出'}</span>` +
      ` $${formatVolume(t.usd)} @ ${t.price.toFixed(2)}` +
      `<br><span class="time">${formatTime(t.time)} · ${t.source}</span></li>`
    )
    .join('');
  setHtmlIfChanged(ul, html);
}

// ---------------- 标注：信号 + 宏观事件 + 摆动点 ----------------

function nearestCandleTime(t) {
  const candles = state.candles;
  if (candles.length === 0) return null;
  if (t < candles[0].time || t > candles[candles.length - 1].time) return null;
  let lo = 0, hi = candles.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (candles[mid].time <= t) lo = mid;
    else hi = mid - 1;
  }
  return candles[lo].time;
}

const eventMarkerMap = new Map();

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
      if (s.score < 3) continue;
      markers.push({
        time: s.time,
        position: s.side === 'buy' ? 'belowBar' : 'aboveBar',
        color: s.side === 'buy' ? '#0e9f6e' : '#e02424',
        shape: s.side === 'buy' ? 'arrowUp' : 'arrowDown',
        text: s.side === 'buy' ? 'B' : 'S',
      });
    }
  }

  if ($('toggleEvents') && $('toggleEvents').checked) {
    for (const evt of chartEvents()) {
      const t = nearestCandleTime(evt.time);
      if (t === null) continue;
      if (!eventMarkerMap.has(t)) eventMarkerMap.set(t, []);
      eventMarkerMap.get(t).push(evt);
      markers.push({
        time: t,
        position: 'aboveBar',
        color: EVENT_CATEGORIES[evt.category].color,
        shape: 'circle',
      });
    }
  }

  if ($('toggleSwings').checked && state.indicators && state.indicators.swings) {
    for (const sw of state.indicators.swings.slice(-14)) {
      markers.push({
        time: sw.time,
        position: sw.type === 'high' ? 'aboveBar' : 'belowBar',
        color: '#66738a',
        shape: sw.type === 'high' ? 'arrowDown' : 'arrowUp',
        text: sw.price >= 1000 ? sw.price.toFixed(0) : sw.price.toFixed(2),
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
    .map((e) =>
      `<div class="tt-title">${escapeHtml(e.title)}</div>` +
      `<div class="tt-note">${formatTime(e.time)} · ${EVENT_CATEGORIES[e.category].label}` +
      (e.note ? `<br>${escapeHtml(e.note)}` : '') + `</div>`
    )
    .join('<hr style="border-color:#dde3ec">');
  tooltip.classList.remove('hidden');
  const rect = $('mainChart').getBoundingClientRect();
  tooltip.style.left = `${Math.min(rect.left + (param.point?.x ?? 0) + 16, window.innerWidth - 320)}px`;
  tooltip.style.top = `${rect.top + (param.point?.y ?? 0) + 16}px`;
});

// ---------------- 侧栏渲染 ----------------

function formatTime(t) {
  const d = new Date((t + 8 * 3600) * 1000);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function escapeHtml(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function renderSignalList() {
  const ul = $('signalList');
  const recent = state.signals.slice(-20).reverse();
  const html = recent.length === 0
    ? '<li class="reasons">暂无信号</li>'
    : recent
        .map((s) =>
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
  const del = e.id.startsWith('c') ? `<button class="del" data-id="${e.id}" title="删除">✕</button>` : '';
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
    const html = items.length ? items.map(eventItemHtml).join('') : `<li class="reasons">${empty}</li>`;
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

// ---------------- 资产信息 + Gamma ----------------

function renderAssetInfo() {
  const info = getAssetInfo(state.symbol);
  setHtmlIfChanged(
    $('assetInfoBox'),
    `<div><b>${escapeHtml(info.name)}</b><span class="asset-cat">${escapeHtml(info.category)}</span></div>` +
      `<div class="co-desc" style="margin-top:4px">${escapeHtml(info.desc)}</div>` +
      `<div class="sy-note"><b>重点关注：</b>${escapeHtml(info.watch)}</div>`
  );
}

async function refreshGamma() {
  const base = getSymbol(state.symbol).base;
  const box = $('gammaBox');
  if (base !== 'BTC' && base !== 'ETH') {
    setHtmlIfChanged(box, '<div class="advisor-loading">Gamma环境仅支持 BTC/ETH（Deribit期权数据）</div>');
    state.gamma = null;
    return;
  }
  state.gamma = await fetchGex(base);
  if (!state.gamma) {
    setHtmlIfChanged(box, '<div class="advisor-loading">期权数据获取失败，稍后自动重试</div>');
    return;
  }
  const g = state.gamma;
  const cls = g.regime === 'positive' ? 'good' : 'bad';
  setHtmlIfChanged(
    box,
    `<div class="rv-stat"><span>Gamma环境</span><span class="rv-rate ${cls}">${g.regime === 'positive' ? '正Gamma（震荡市）' : '负Gamma（趋势市）'}</span></div>` +
      `<div class="rv-stat"><span>GEX</span><span>$${(g.gex / 1e6).toFixed(1)}M / 1%波动</span></div>` +
      (g.callWall ? `<div class="rv-stat"><span>Call Wall（上方压力）</span><span>${g.callWall.strike}</span></div>` : '') +
      (g.putWall ? `<div class="rv-stat"><span>Put Wall（下方支撑）</span><span>${g.putWall.strike}</span></div>` : '') +
      `<div class="rv-reflect">${escapeHtml(explainGex(g))}</div>`
  );
}

// ---------------- 分析报告存档 + 每日两次复盘 ----------------

function archiveReport() {
  const adv = state.advice;
  if (!adv) return;
  const price = state.candles.length ? state.candles[state.candles.length - 1].close : null;
  const report = generateReport({
    symbol: state.symbol,
    symbolLabel: getSymbol(state.symbol).label,
    price,
    strategies: adv.strategies,
    perTf: adv.perTf,
    gamma: state.gamma,
    newsBias: computeNewsBias(),
  });
  reports.add(report);
  renderReports();
}

function renderReports() {
  const box = $('reportBox');
  const recent = reports.recent(10);
  if (!recent.length) {
    setHtmlIfChanged(box, '<div class="advisor-loading">暂无报告</div>');
    return;
  }
  setHtmlIfChanged(
    box,
    recent
      .map((r) => {
        const secs = (r.sections || [])
          .map((s) =>
            `<div class="rpt-sec"><b>${escapeHtml(s.title)}</b><ul>${(s.lines || []).map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul></div>`
          )
          .join('');
        return (
          `<div class="rpt-card"><details><summary class="rpt-head">` +
          `<span>${escapeHtml(r.symbolLabel)} @${r.price ? r.price.toFixed(1) : '-'}</span>` +
          `<span>${formatTime(r.time)}</span></summary>` +
          `<div class="rpt-body">${secs}</div></details></div>`
        );
      })
      .join('')
  );
}

/** 每日两次复盘：UTC+8 10:00 与 23:00 */
const reviewDone = new Set();
function checkDailyReview() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const hh = now.getUTCHours();
  const mm = now.getUTCMinutes();
  const dayKey = now.toISOString().slice(0, 10);
  for (const target of [10, 23]) {
    const key = `${dayKey}|${target}`;
    if (hh === target && mm < 2 && !reviewDone.has(key)) {
      reviewDone.add(key);
      runDailyReview(target);
    }
  }
}

function runDailyReview(hour) {
  const today = Math.floor((Math.floor(Date.now() / 1000) + 8 * 3600) / 86400);
  const todayReports = reports.ofDay(today);
  const todayStart = (today * 86400 - 8 * 3600);
  const closedToday = wallet.closed.filter((t) => t.exitTime >= todayStart);
  const topNews = state.newsEvents.slice(0, 3);
  const review = generateDailyReview({
    dateLabel: `${hour}:00`,
    reports: todayReports,
    walletStats: wallet.stats(),
    closedToday,
    topNews,
    reflections: state.reflections,
  });
  reports.add({ ...review, symbol: state.symbol, symbolLabel: '每日复盘', sections: [{ title: '复盘', lines: review.lines }] });
  renderReports();
  renderDailyReviewBox();
  pushAlert({
    key: `dailyreview|${review.time}`,
    title: `每日复盘（${hour === 10 ? '早上10点' : '晚上11点'}）`,
    body: review.lines.join('\n'),
    kind: 'risk',
    external: true,
  });
}

function renderDailyReviewBox() {
  const box = $('dailyReviewBox');
  const reviews = reports.reports.filter((r) => r.type === 'daily-review').slice(-6).reverse();
  if (!reviews.length) {
    setHtmlIfChanged(box, '<div class="advisor-loading">每天 10:00 / 23:00 (UTC+8) 自动生成并推送</div>');
    return;
  }
  setHtmlIfChanged(
    box,
    reviews
      .map((r) =>
        `<div class="rpt-card"><div class="rpt-head"><span><b>${escapeHtml(r.dateLabel)}</b> 复盘</span><span>${formatTime(r.time)}</span></div>` +
        `<div class="rpt-body"><ul>${r.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul></div></div>`
      )
      .join('')
  );
}

// ---------------- 模拟交易钱包 ----------------

function walletMark(symbol, price) {
  const closed = wallet.markPrice(symbol, price, Math.floor(Date.now() / 1000));
  for (const t of closed) {
    const causeLabel = { stop: '止损', target: '止盈', liquidated: '强平', manual: '手动' }[t.cause] || t.cause;
    pushAlert({
      key: `walletclose|${t.id}`,
      title: `模拟钱包平仓（${causeLabel}）：${t.netPnl >= 0 ? '✓盈利' : '✗亏损'} ${t.netPnl >= 0 ? '+' : ''}$${t.netPnl.toFixed(1)}`,
      body: `${t.symbol} ${t.side === 'long' ? '多' : '空'}${t.leverage}x · ${t.entry.toFixed(1)}→${t.exit.toFixed(1)} · ROI ${t.roiPct >= 0 ? '+' : ''}${t.roiPct.toFixed(1)}%`,
      kind: t.netPnl >= 0 ? 'buy' : 'risk',
      external: true,
    });
  }
  if (closed.length) { renderWalletTab(); renderAiReview(); }
}

function renderWalletTab() {
  const box = $('walletBox');
  if (!box) return;
  const prices = {};
  if (state.candles.length) prices[state.symbol] = state.candles[state.candles.length - 1].close;
  const spotEq = wallet.equitySpot(prices);
  const base = wallet.baseCapital || 10000;
  const totalRet = ((spotEq - base) / base) * 100;
  const s = wallet.stats();
  const pct = (x) => (x === null ? '-' : (x * 100).toFixed(0) + '%');

  const posHtml = wallet.positions.length
    ? wallet.positions
        .map((p) => {
          const px = prices[p.symbol] ?? p.lastPrice;
          const u = wallet.unrealized(p, px) - (p.fundingPaid || 0);
          const cls = u >= 0 ? 'up' : 'down';
          return (
            `<div class="pos-card"><div class="pos-head">` +
            `<span><b>${escapeHtml(p.symbol)}</b> ${p.side === 'long' ? '做多' : '做空'} ${p.leverage}x <span class="sy-note">保证金$${p.margin}</span></span>` +
            `<span class="${cls}">${u >= 0 ? '+' : ''}$${u.toFixed(1)}（${((u / p.margin) * 100).toFixed(0)}%）</span></div>` +
            `<div class="sy-note">开仓 ${formatTime(p.openTime)} @${p.entry.toFixed(1)} · 现价${px.toFixed(1)} · 止损${p.stop !== null ? p.stop.toFixed(1) : '-'} · 目标${p.target !== null ? p.target.toFixed(1) : '-'} · 已付资金费$${(p.fundingPaid || 0).toFixed(2)}</div>` +
            `<div class="sy-note">策略：${escapeHtml(p.reason)}</div>` +
            `<button class="pos-close-btn" data-pid="${p.id}">手动平仓</button></div>`
          );
        })
        .join('')
    : '<div class="sy-note">当前无持仓（只在高置信信号出现时开仓，不频繁交易）</div>';

  const daily = wallet.dailyTradeReturns(14);
  const dailyHtml = daily.length
    ? `<table class="sy-table"><thead><tr><th>日期</th><th>平仓笔数</th><th>胜/负</th><th>净盈亏</th><th>保证金ROI</th></tr></thead><tbody>` +
      daily
        .map((d) =>
          `<tr><td>${d.dateLabel}</td><td>${d.trades}</td><td>${d.wins}/${d.trades - d.wins}</td>` +
          `<td class="${d.pnl >= 0 ? 'up' : 'down'}">${d.pnl >= 0 ? '+' : ''}$${d.pnl.toFixed(1)}</td>` +
          `<td class="${(d.roiPct ?? 0) >= 0 ? 'up' : 'down'}">${d.roiPct !== null ? (d.roiPct >= 0 ? '+' : '') + d.roiPct.toFixed(1) + '%' : '-'}</td></tr>`
        )
        .join('') +
      `</tbody></table>`
    : '<div class="sy-note">暂无平仓记录（只有真实开仓并平仓的日期才计入复盘）</div>';

  box.innerHTML =
    `<div class="wallet-summary">` +
    `<div class="w-total ${totalRet >= 0 ? 'up' : 'down'}">$${spotEq.toFixed(1)} <small>${totalRet >= 0 ? '+' : ''}${totalRet.toFixed(2)}%</small></div>` +
    `<div class="sy-note">现金 $${wallet.cash.toFixed(1)} · 初始本金 $${base.toFixed(0)} · 持仓 ${s.openCount}/${wallet.maxOpen}</div>` +
    `<div class="sy-note">累计：${s.spotTrades}笔 胜率${pct(s.spotWinRate)} 净盈亏${s.spotNetPnl >= 0 ? '+' : ''}$${s.spotNetPnl.toFixed(1)} 总费用$${s.totalFees.toFixed(1)}</div>` +
    `</div>` +
    `<div class="bt-htitle">当前持仓（可手动平仓）</div>` + posHtml +
    `<div class="bt-htitle" style="margin-top:8px">每日收益复盘（仅有平仓的日期）</div>` + dailyHtml +
    (state.usingMock
      ? `<div class="rv-reflect" style="margin-top:6px">⚠ 当前为离线模拟行情，自动交易已暂停；连接真实行情后自动恢复。</div>`
      : '') +
    `<div class="rv-reflect" style="margin-top:6px">规则：初始资金可在设置调整（默认$10000） · 单笔保证金$500-1000 · 杠杆10-30x（最高30倍，按强烈信号强度分档） · ` +
    `币安标准费率：开平各收 taker 0.05%（按名义价值）+ 资金费0.01%/8h · 亏损95%强平 · 最多3仓 · 同键6小时冷却 · 只跟存档的强烈信号开仓，不刷单</div>`;

  box.querySelectorAll('.pos-close-btn').forEach((btn) =>
    btn.addEventListener('click', () => {
      const pos = wallet.positions.find((p) => p.id === btn.dataset.pid);
      if (!pos) return;
      const px = prices[pos.symbol] ?? pos.lastPrice;
      if (!confirm(`确认手动平仓 ${pos.symbol} ${pos.side === 'long' ? '多' : '空'}${pos.leverage}x？按现价 ${px.toFixed(1)} 平仓。`)) return;
      const rec = wallet.closePosition(pos.id, px, Math.floor(Date.now() / 1000), 'manual');
      if (rec) {
        pushAlert({
          key: `walletclose|${rec.id}`,
          title: `手动平仓：${rec.netPnl >= 0 ? '✓盈利' : '✗亏损'} ${rec.netPnl >= 0 ? '+' : ''}$${rec.netPnl.toFixed(1)}`,
          body: `${rec.symbol} ROI ${rec.roiPct >= 0 ? '+' : ''}${rec.roiPct.toFixed(1)}%`,
          kind: rec.netPnl >= 0 ? 'buy' : 'risk',
        });
        renderWalletTab();
        renderAiReview();
      }
    })
  );
}

// ---------------- AI交易复盘（只记录模拟钱包真实开仓） ----------------

function renderAiReview() {
  const box = $('aiReviewBox');
  if (!box) return;
  const closed = wallet.closed;
  if (!closed.length) {
    setHtmlIfChanged(box, '<div class="advisor-loading">暂无交易记录——AI只在高置信信号时开仓，无开仓不记录</div>');
    return;
  }
  const s = wallet.stats();
  const pct = (x) => (x === null ? '-' : (x * 100).toFixed(0) + '%');

  const rows = closed
    .slice()
    .sort((a, b) => a.openTime - b.openTime)
    .map((t) => {
      const causeLabel = { stop: '止损', target: '止盈', liquidated: '强平', manual: '手动' }[t.cause] || t.cause;
      const cls = t.netPnl >= 0 ? 'up' : 'down';
      return (
        `<tr><td>${formatTime(t.openTime)}</td>` +
        `<td>${escapeHtml(t.symbol)} ${t.side === 'long' ? '多' : '空'}</td>` +
        `<td>${t.entry.toFixed(1)}</td>` +
        `<td>${formatTime(t.exitTime)}</td>` +
        `<td>${t.exit.toFixed(1)}</td>` +
        `<td>${t.leverage}x</td>` +
        `<td>${causeLabel}</td>` +
        `<td class="${cls}">${t.netPnl >= 0 ? '+' : ''}$${t.netPnl.toFixed(1)}</td>` +
        `<td class="${cls}">${t.roiPct >= 0 ? '+' : ''}${t.roiPct.toFixed(0)}%</td></tr>`
      );
    })
    .join('');

  // 反思：基于真实交易结果
  const reflections = [];
  const recent10 = closed.slice(-10);
  if (recent10.length >= 3) {
    const wr = recent10.filter((t) => t.netPnl > 0).length / recent10.length;
    if (wr < 0.4) reflections.push(`近${recent10.length}笔胜率仅${(wr * 100).toFixed(0)}%——正在降低开仓频率、提高信号门槛，避免连续亏损扩大`);
    else if (wr >= 0.6) reflections.push(`近${recent10.length}笔胜率${(wr * 100).toFixed(0)}%表现稳定，维持当前信号标准`);
    const liqCount = recent10.filter((t) => t.cause === 'liquidated').length;
    if (liqCount > 0) reflections.push(`近期有${liqCount}笔强平——高杠杆下止损距离过近，已将止损放宽至1.5×ATR以上并降低杠杆档位`);
    const avgFee = recent10.reduce((s2, t) => s2 + t.openFee + t.closeFee + (t.funding || 0), 0) / recent10.length;
    const avgWin = recent10.filter((t) => t.netPnl > 0).reduce((s2, t) => s2 + t.netPnl, 0) / Math.max(1, recent10.filter((t) => t.netPnl > 0).length);
    if (avgFee > avgWin * 0.3) reflections.push('费用占平均盈利比例偏高，高频短持在不划算——拉长持有周期以摊薄手续费与资金费');
  }

  setHtmlIfChanged(
    box,
    `<div class="rv-stat"><span>累计交易</span><span>${s.spotTrades}笔</span></div>` +
      `<div class="rv-stat"><span>胜率</span><span class="rv-rate ${s.spotWinRate >= 0.55 ? 'good' : s.spotWinRate < 0.45 ? 'bad' : ''}">${pct(s.spotWinRate)}</span></div>` +
      `<div class="rv-stat"><span>净盈亏</span><span class="rv-rate ${s.spotNetPnl >= 0 ? 'good' : 'bad'}">${s.spotNetPnl >= 0 ? '+' : ''}$${s.spotNetPnl.toFixed(1)}</span></div>` +
      `<div class="rv-stat"><span>总费用（手续费+资金费）</span><span>$${s.totalFees.toFixed(1)}</span></div>` +
      (reflections.length ? `<div class="rv-reflect"><b>反思：</b>${reflections.map(escapeHtml).join('；')}</div>` : '') +
      `<div class="bt-htitle" style="margin-top:8px">全部交易明细（时间升序 · ${closed.length}笔）</div>` +
      `<div class="bt-scroll"><table class="sy-table"><thead>` +
      `<tr><th>开仓时间</th><th>品种·方向</th><th>开仓价</th><th>平仓时间</th><th>平仓价</th><th>杠杆</th><th>平仓原因</th><th>净盈亏</th><th>ROI</th></tr>` +
      `</thead><tbody>${rows}</tbody></table></div>`
  );
}

// ---------------- Serenity ----------------

let serenityLoaded = false;

async function refreshSerenity() {
  if (serenityLoaded) return;
  serenityLoaded = true;
  const tickers = [...new Set(SERENITY_PICKS.map((p) => p.ticker))];
  const snap = await snapshotBatch(tickers);
  renderSerenity(snap, 'snapshot');
  try {
    const live = await fetchDailyBatch(tickers);
    const liveCount = Object.values(live).filter(Boolean).length;
    if (liveCount >= tickers.length / 2) {
      for (const t of tickers) if (!live[t]) live[t] = snap[t];
      renderSerenity(live, 'live');
    }
  } catch (_) { /* 保持快照渲染 */ }
}

function renderSerenity(daily, mode) {
  const subs = buildSubIndices(daily);
  const subBox = $('serenitySubBox');
  if (subs.length) {
    subBox.innerHTML = subs
      .map((s) => {
        const cls = s.index.changePct >= 0 ? 'good' : 'bad';
        return (
          `<div class="rv-stat"><span><span class="sy-tag" style="background:${s.color}">${s.label}</span> ` +
          `<span class="sy-note">${s.tickers.join(' ')}</span></span>` +
          `<span class="rv-rate ${cls}">${s.index.current.toFixed(1)}（${s.index.changePct >= 0 ? '+' : ''}${s.index.changePct.toFixed(1)}%）</span></div>`
        );
      })
      .join('') +
      `<div class="sy-note" style="margin-top:3px">子指数=该行业成分等权、基期100</div>`;
  } else {
    subBox.innerHTML = '<div class="advisor-loading">行情不足，无法合成子指数</div>';
  }

  const idx = buildSerenityIndex(daily);
  const idxBox = $('serenityIndexBox');
  if (idx) {
    const cls = idx.changePct >= 0 ? 'up' : 'down';
    const step = Math.ceil(idx.series.length / 20);
    const spark = idx.series
      .map((p, i) => (i % step === 0 || i === idx.series.length - 1 ? p.value.toFixed(1) : null))
      .filter(Boolean)
      .join(' → ');
    idxBox.innerHTML =
      `<span class="sy-idx ${cls}">${idx.current.toFixed(2)}</span> ` +
      `<span class="rv-rate ${cls === 'up' ? 'good' : 'bad'}">${idx.changePct >= 0 ? '+' : ''}${idx.changePct.toFixed(2)}% / 30天</span>` +
      `<div class="sy-note">覆盖${idx.covered}/${idx.total}只成分 · 等权重 · 基期=100 · ${mode === 'snapshot' ? '内置快照数据' : '实时数据'}</div>` +
      `<div class="sy-note">走势：${spark}</div>`;
  } else {
    idxBox.innerHTML = '<div class="advisor-loading">行情不可用，无法合成指数</div>';
  }

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
          `</div><div class="sy-detail" id="syd-${escapeHtml(r.ticker)}"></div></div>`
        );
      })
      .join('') +
    `<div class="sy-note" style="margin-top:4px">◆=本人公开披露持仓 · 评分=叙事权重×2+30天动量+披露加成 · 点击展开详情</div>`;

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

  const pr = SERENITY_PROFILE;
  $('serenityProfileBox').innerHTML =
    `<div class="rv-stat"><span>持股数据更新于</span><span>${formatTime(SERENITY_DATA_UPDATED)}</span></div>` +
    `<div class="rv-stat"><span>账号</span><span><a href="${pr.url}" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">${pr.handle}</a>（${pr.followers}粉丝）</span></div>` +
    `<div class="rv-stat"><span>风格</span><span>${escapeHtml(pr.style)}</span></div>` +
    `<div class="interp"><b>核心框架：</b>${escapeHtml(pr.framework)}</div>` +
    `<div class="interp"><b>代表战绩：</b>${escapeHtml(pr.record)}</div>` +
    `<div class="rv-reflect">${escapeHtml(pr.risk)}</div>`;
}

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

  fetchQuoteMeta(ticker)
    .then((q) => {
      const qe = $(`coq-${ticker}`);
      if (!qe) return;
      if (!q) { qe.innerHTML = '<span class="sy-note">实时行情不可达</span>'; return; }
      const range = q.high52 && q.low52
        ? ` · 52周 ${q.low52.toFixed(2)}~${q.high52.toFixed(2)}（距高点${(((q.price - q.high52) / q.high52) * 100).toFixed(0)}%）`
        : '';
      qe.innerHTML = `<span class="co-price">${q.price.toFixed(2)} ${escapeHtml(q.currency)}</span><span class="sy-note">${range}</span>`;
    })
    .catch(() => {});

  fetchCompanyNews(ticker, co.name)
    .then((items) => {
      const ne = $(`con-${ticker}`);
      if (!ne) return;
      if (!items.length) { ne.innerHTML = '<span class="sy-note">暂无公司新闻或网络受限</span>'; return; }
      ne.innerHTML =
        `<div class="co-news-h">最新公司新闻</div>` +
        items.slice(0, 6).map((it) =>
          `<div class="co-news-i"><a href="${escapeHtml(it.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(it.title)}</a>` +
          `<span class="sy-note"> · ${escapeHtml(it.source)} · ${formatTime(it.time)}</span></div>`
        ).join('');
    })
    .catch(() => {});
}

async function refreshSerenityFeed() {
  const box = $('serenityFeedBox');
  const items = await fetchSerenityFeed();
  if (!items.length) {
    setHtmlIfChanged(box, '<div class="advisor-loading">暂无近3天动态或网络受限</div>');
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
      `<div class="sy-note" style="margin-top:4px">X推文API需付费，无法直接抓取@aleabitoreddit实时推文；本面板监控其重点标的公开新闻作为替代信号。</div>`
  );
}

// ---------------- 多品种后台信号监控 ----------------

const watcherState = { running: false };

async function watchAllSymbols() {
  if (watcherState.running || state.usingMock) return;
  watcherState.running = true;
  try {
    const targets = SYMBOLS.filter((s) => s.id !== state.symbol && s.source !== 'stock');
    for (const sym of targets) {
      try {
        const candles = await fetchHistory(sym.id, state.interval, 160);
        if (candles.length < 60) continue;
        walletMark(sym.id, candles[candles.length - 1].close);
        const ind = computeAll(candles);
        const signals = generateSignals(candles, ind);
        if (!signals.length) continue;
        const lastClosed = candles[candles.length - 2]?.time;
        const s = signals[signals.length - 1];
        if (s.time !== lastClosed || s.score < 3) continue;
        pushAlert({
          key: `watch|${sym.id}|${s.time}|${s.side}`,
          title: `${sym.label} ${s.side === 'buy' ? '买入' : '卖出'}信号（强度${s.score}）`,
          body: s.reasons.join('；'),
          kind: s.side,
        });
        if (s.score >= 4) {
          const atrArr = ind.atr;
          const atrV = atrArr[atrArr.length - 1] ?? atrArr[atrArr.length - 2];
          if (atrV) {
            const entry = candles[candles.length - 1].close;
            const long = s.side === 'buy';
            const lev = leverageFromScore(s.score, 4);
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
              pushAlert({
                key: `walletopen|${res.id}`,
                title: `模拟钱包开仓：${sym.label} ${long ? '做多' : '做空'} ${lev}x`,
                body: `保证金$500 · 入场${entry.toFixed(2)}`,
                kind: long ? 'buy' : 'sell',
                external: true,
              });
              renderWalletTab();
              renderAiReview();
            }
          }
        }
      } catch (_) { /* 单品种失败不影响其他 */ }
    }
  } finally {
    watcherState.running = false;
  }
}

// ---------------- 新闻 + KOL雷达 ----------------

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

async function refreshKolRadar() {
  const box = $('kolBox');
  if (!box) return;
  const s = getSettings();
  const items = await fetchKolSignals(s.xAccounts, s.tgChannels);
  const listHtml = items.length
    ? items
        .map((x) =>
          `<div class="kol-item"><span class="bias ${x.bias}">${x.bias === 'bullish' ? '看多' : x.bias === 'bearish' ? '看空' : '中性'}</span>` +
          (x.open ? '<span class="kol-open">开仓/建议</span>' : '') +
          (x.coins || []).map((c) => `<span class="kol-coin">${c}</span>`).join('') +
          `<span class="kol-name">${escapeHtml(x.kol)}</span>` +
          `<a href="${escapeHtml(x.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(x.title)}</a>` +
          `<br><span class="time">${formatTime(x.time)} · ${escapeHtml(x.platform || 'X')} · <a href="${escapeHtml(x.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--muted)">${escapeHtml(x.handle)}</a></span></div>`
        )
        .join('')
    : '<div class="advisor-loading">暂无近期公开开仓信号（X/TG直连需Key，当前走公开RSS与转载检索；网络受限时也会为空）</div>';

  const kolListHtml =
    `<details class="kol-list-note"><summary class="tf-head"><span class="tf-name">监控清单与说明</span></summary>` +
    `<div class="sy-note">${getKolList(s.xAccounts).map((k) => `${escapeHtml(k.name)}（${escapeHtml(k.handle)}·${escapeHtml(k.style)}）`).join('；')}</div>` +
    `<div class="sy-note" style="margin-top:4px">关注风格参考 <a href="https://x.com/johnliu409" target="_blank" rel="noopener">x.com/johnliu409</a>。可在设置中追加你的X关注；Telegram社群链接稍后填入公开频道用户名或 t.me 链接即可接入。KOL观点不构成投资建议。</div></details>`;

  setHtmlIfChanged(box, listHtml + kolListHtml);
}

// ---------------- 侧栏Tab切换 ----------------

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-page').forEach((p) => p.classList.toggle('active', p.id === btn.dataset.tab));
    if (btn.dataset.tab === 'tabSerenity') {
      refreshSerenity();
      if (!$('serenityFeedBox').dataset.loaded) {
        $('serenityFeedBox').dataset.loaded = '1';
        refreshSerenityFeed();
        setInterval(refreshSerenityFeed, 10 * 60 * 1000);
      }
    }
    if (btn.dataset.tab === 'tabReport') { renderReports(); renderDailyReviewBox(); }
    if (btn.dataset.tab === 'tabReview') renderAiReview();
    if (btn.dataset.tab === 'tabKol') refreshKolRadar();
  });
});

// ---------------- 交互绑定 ----------------

const symbolSelect = $('symbolSelect');
symbolSelect.innerHTML = SYMBOLS.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
symbolSelect.value = state.symbol;

function renderSymbolPills() {
  const box = $('symbolPills');
  if (!box) return;
  const crypto = SYMBOLS.filter((s) => s.source !== 'stock');
  box.innerHTML = crypto
    .map(
      (s) =>
        `<button type="button" class="pill${s.id === state.symbol ? ' active' : ''}" data-id="${s.id}">${escapeHtml(s.base)}</button>`
    )
    .join('');
  box.querySelectorAll('.pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.id === state.symbol) return;
      state.symbol = btn.dataset.id;
      symbolSelect.value = state.symbol;
      renderSymbolPills();
      loadSymbol();
    });
  });
}

function formatPx(px) {
  if (px == null || !Number.isFinite(px)) return '—';
  if (px >= 1000) return px.toFixed(1);
  if (px >= 10) return px.toFixed(2);
  return px.toFixed(4);
}

function renderQuoteBar() {
  const symEl = $('quoteSymbol');
  const pxEl = $('quotePrice');
  const chgEl = $('quoteChange');
  if (!symEl) return;
  const sym = getSymbol(state.symbol);
  symEl.textContent = sym.label;
  const candles = state.candles;
  if (!candles.length) {
    pxEl.textContent = '—';
    chgEl.textContent = '';
    chgEl.className = 'q-chg';
    return;
  }
  const last = candles[candles.length - 1];
  const ref = candles.length > 1 ? candles[candles.length - 2].close : last.open;
  const pct = ref ? ((last.close - ref) / ref) * 100 : 0;
  pxEl.textContent = formatPx(last.close);
  chgEl.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
  chgEl.className = `q-chg ${pct >= 0 ? 'up' : 'down'}`;
}

renderSymbolPills();

symbolSelect.addEventListener('change', (e) => {
  state.symbol = e.target.value;
  renderSymbolPills();
  loadSymbol();
});
$('intervalSelect').addEventListener('change', (e) => { state.interval = e.target.value; loadSymbol(); });
$('subIndicatorSelect').addEventListener('change', (e) => { state.subIndicator = e.target.value; renderSubIndicator(); });
$('toggleEvents').addEventListener('change', renderMarkers);
$('toggleSignals').addEventListener('change', renderMarkers);
$('toggleSwings').addEventListener('change', renderMarkers);
$('toggleMute').addEventListener('change', (e) => { alerts.muted = e.target.checked; });
$('advisorRefresh').addEventListener('click', refreshAdvisorAndVolume);
$('newsRefresh').addEventListener('click', refreshNews);
$('eventForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('evtTime').value;
  const title = $('evtTitle').value.trim();
  if (!t || !title) return;
  addCustomEvent({
    time: Math.floor(new Date(t).getTime() / 1000),
    title,
    category: $('evtCategory').value,
    impact: $('evtImpact').value,
    note: $('evtNote').value.trim(),
  });
  e.target.reset();
  renderEventList();
  renderMarkers();
});

$('walletAddSpot').addEventListener('click', () => {
  const amt = prompt('注资多少美元？', '5000');
  if (amt === null) return;
  if (wallet.addFunds(amt)) renderWalletTab();
  else alert('金额无效');
});

$('walletWithdraw').addEventListener('click', () => {
  const amt = prompt(`出金多少美元？（可用现金 $${wallet.cash.toFixed(0)}）`, '1000');
  if (amt === null) return;
  if (wallet.withdrawFunds(amt)) renderWalletTab();
  else alert('金额无效或超过可用现金');
});

$('walletSetInitial').addEventListener('click', () => {
  const amt = prompt('设置初始资金（美元），将清空全部记录重新开始：', '10000');
  if (amt === null) return;
  if (!confirm('设置初始资金会清空全部持仓与历史记录，确认？')) return;
  if (wallet.setInitialCapital(amt)) renderWalletTab();
  else alert('金额无效（100-10,000,000）');
});

$('walletReset').addEventListener('click', () => {
  if (!confirm('确认重置模拟钱包？将清空全部持仓与收益记录。')) return;
  wallet.setInitialCapital(getSettings().initialCapital);
  renderWalletTab();
  renderAiReview();
});

// 设置弹窗
$('settingsBtn').addEventListener('click', () => {
  const s = getSettings();
  $('setTgToken').value = s.telegramToken;
  $('setTgChat').value = s.telegramChatId;
  $('setEmailHook').value = s.emailWebhook;
  $('setInitCapital').value = s.initialCapital;
  $('setXAccounts').value = s.xAccounts;
  $('setTgChannels').value = s.tgChannels;
  $('settingsModal').classList.remove('hidden');
});
$('settingsClose').addEventListener('click', () => $('settingsModal').classList.add('hidden'));
$('settingsSave').addEventListener('click', () => {
  saveSettings({
    telegramToken: $('setTgToken').value.trim(),
    telegramChatId: $('setTgChat').value.trim(),
    emailWebhook: $('setEmailHook').value.trim(),
    initialCapital: Number($('setInitCapital').value) || 10000,
    xAccounts: $('setXAccounts').value.trim(),
    tgChannels: $('setTgChannels').value.trim(),
  });
  $('settingsModal').classList.add('hidden');
  refreshKolRadar();
  alert('设置已保存');
});
$('testNotify').addEventListener('click', async () => {
  saveSettings({
    telegramToken: $('setTgToken').value.trim(),
    telegramChatId: $('setTgChat').value.trim(),
    emailWebhook: $('setEmailHook').value.trim(),
  });
  $('notifyTestResult').textContent = '发送中…';
  const [tg, em] = await Promise.all([
    sendTelegram('K线智能分析终端：测试提醒 ✓'),
    sendEmail('K线智能分析终端测试', '测试提醒 ✓'),
  ]);
  $('notifyTestResult').textContent = `Telegram: ${tg.ok ? '✓成功' : '✗' + tg.reason} · 邮箱: ${em.ok ? '✓成功' : '✗' + em.reason}`;
});

// ---------------- 启动 ----------------

alerts.requestPermission();
renderArchive();
loadSymbol();
renderWalletTab();
renderAiReview();
renderReports();
renderDailyReviewBox();

setInterval(refreshAdvisorAndVolume, 30 * 60 * 1000);
setInterval(refreshNews, 5 * 60 * 1000);
refreshKolRadar();
setInterval(refreshKolRadar, 10 * 60 * 1000);
setInterval(refreshGamma, 10 * 60 * 1000);
setInterval(watchAllSymbols, 2 * 60 * 1000);
setInterval(() => { checkDailyReview(); }, 60 * 1000);
setInterval(() => {
  settleReviews();
  renderReviewPanel();
}, 60 * 1000);
// 权益快照
wallet.snapshotEquity(Math.floor(Date.now() / 1000), {});
setInterval(() => {
  const prices = {};
  if (state.candles.length) prices[state.symbol] = state.candles[state.candles.length - 1].close;
  wallet.snapshotEquity(Math.floor(Date.now() / 1000), prices);
}, 5 * 60 * 1000);

// 版本门
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
  } catch (_) { /* 网络受限时不阻塞使用 */ }
})();
