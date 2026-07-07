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
import { runAdvisor, TIMEFRAMES } from './advisor.js';

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

// ---------------- 图表初始化 ----------------

const chartOpts = {
  layout: { background: { color: 'transparent' }, textColor: '#d7dde8' },
  grid: {
    vertLines: { color: 'rgba(38,48,67,.5)' },
    horzLines: { color: 'rgba(38,48,67,.5)' },
  },
  timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#263043' },
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
  refreshAdvisorAndVolume();
  refreshNews();
}

function onRealtimeBar(bar) {
  const last = state.candles[state.candles.length - 1];
  if (last && bar.time === last.time) {
    state.candles[state.candles.length - 1] = bar;
  } else if (!last || bar.time > last.time) {
    state.candles.push(bar);
    if (state.candles.length > 1500) state.candles.shift();
  } else {
    return;
  }
  recomputeAndRender({ fitContent: false });
}

function onWhaleTrade(trade) {
  whaleFeed.push(trade);
  renderWhaleList();
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

  try {
    state.advice = await runAdvisor(fetchCandles);
  } catch (_) {
    state.advice = null;
  }
  if (state.usingMock) state.candles1h = generateMockHistory('1h', 400);

  renderAdvisor();
  renderVolumePanel();
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

  box.innerHTML =
    `<span class="action ${actionClass(adv.action)}">${escapeHtml(adv.action)}</span>` +
    `<span class="upd"> 更新于 ${formatTime(adv.updatedAt)}${state.usingMock ? '（模拟数据）' : ''}</span>` +
    `<div class="summary">${escapeHtml(adv.summary)}</div>` +
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
      const d = new Date(r.time * 1000);
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
  ul.innerHTML = recent
    .map(
      (a) =>
        `<li><span class="anomaly-tag">${a.type === 'both' ? '量价异动' : a.type === 'volume' ? '放量' : '价格异动'}</span>` +
        `${escapeHtml(a.desc)}<br><span class="time">${formatTime(a.time)}</span></li>`
    )
    .join('');
  if (recent.length === 0) ul.innerHTML = '<li class="reasons">当前周期暂无量价异动</li>';
}

function renderWhaleList() {
  const ul = $('whaleList');
  const recent = whaleFeed.trades.slice(0, 8);
  ul.innerHTML = recent
    .map(
      (t) =>
        `<li><span class="whale-${t.side}">${t.side === 'buy' ? '⬆ 大额买入' : '⬇ 大额卖出'}</span>` +
        ` $${formatVolume(t.usd)} @ ${t.price.toFixed(2)}` +
        `<br><span class="time">${formatTime(t.time)} · ${t.source}</span></li>`
    )
    .join('');
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

function formatTime(t) {
  const d = new Date(t * 1000);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  ul.innerHTML = recent
    .map(
      (s) =>
        `<li><span class="side-${s.side}">${s.side === 'buy' ? '▲ 买入' : '▼ 卖出'}</span>` +
        ` <span>@${s.price.toFixed(2)}</span> <span>强度${s.score}</span>` +
        `<br><span class="time">${formatTime(s.time)}</span>` +
        `<br><span class="reasons">${escapeHtml(s.reasons.join('；'))}</span></li>`
    )
    .join('');
  if (recent.length === 0) ul.innerHTML = '<li class="reasons">暂无信号</li>';
}

function renderEventList() {
  const ul = $('eventList');
  const events = listEvents().slice(0, 30);
  ul.innerHTML = events
    .map((e) => {
      const cat = EVENT_CATEGORIES[e.category];
      const del = e.id.startsWith('c')
        ? `<button class="del" data-id="${e.id}" title="删除">✕</button>`
        : '';
      const src = e.source ? `<span class="src-tag">${escapeHtml(e.source)}</span>` : '';
      const title = e.url
        ? `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.title)}</a>`
        : escapeHtml(e.title);
      return (
        `<li>${del}<span class="cat" style="background:${cat.color}">${cat.label}</span>${src}` +
        `${title}<br><span class="time">${formatTime(e.time)}</span>` +
        (e.note && !e.source ? `<br><span class="note">${escapeHtml(e.note)}</span>` : '') +
        `</li>`
      );
    })
    .join('');
  ul.querySelectorAll('.del').forEach((btn) =>
    btn.addEventListener('click', () => {
      removeCustomEvent(btn.dataset.id);
      renderMarkers();
      renderEventList();
    })
  );
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
