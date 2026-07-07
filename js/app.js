/**
 * 页面主逻辑：图表渲染、实时数据、指标叠加、事件标注、信号报警
 */
import { computeAll } from './indicators.js';
import { generateSignals, AlertManager } from './signals.js';
import {
  EVENT_CATEGORIES,
  getAllEvents,
  addCustomEvent,
  removeCustomEvent,
  fetchLiveEvents,
} from './events.js';
import {
  fetchHistory,
  subscribeKline,
  generateMockHistory,
  subscribeMockKline,
} from './datafeed.js';

const $ = (id) => document.getElementById(id);

const state = {
  symbol: 'BTCUSDT',
  interval: '1h',
  candles: [],
  indicators: null,
  signals: [],
  liveEvents: [],
  unsubscribe: null,
  usingMock: false,
  subIndicator: 'rsi',
};

const alerts = new AlertManager({ onAlert: showToast });

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

const macdHist = macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
const macdDif = macdChart.addLineSeries({ color: '#e6b800', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
const macdDea = macdChart.addLineSeries({ color: '#4d94ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

let subSeries = []; // 副图动态系列

// 三个图表时间轴联动
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

let loadToken = 0; // 防止快速切换品种时旧请求覆盖新数据

async function loadSymbol() {
  const token = ++loadToken;
  if (state.unsubscribe) {
    state.unsubscribe();
    state.unsubscribe = null;
  }
  alerts.reset();
  setStatus('加载历史K线…', '');

  try {
    const candles = await fetchHistory(state.symbol, state.interval, 500);
    if (token !== loadToken) return; // 已被更新的加载请求取代
    state.candles = candles;
    state.usingMock = false;
    state.unsubscribe = subscribeKline(
      state.symbol,
      state.interval,
      onRealtimeBar,
      () => setStatus('行情连接异常，自动重连中', 'err')
    );
    setStatus(`已连接 · ${state.symbol}`, 'ok');
  } catch (err) {
    if (token !== loadToken) return;
    // 网络受限时降级为模拟行情
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
}

function onRealtimeBar(bar) {
  const last = state.candles[state.candles.length - 1];
  if (last && bar.time === last.time) {
    state.candles[state.candles.length - 1] = bar;
  } else if (!last || bar.time > last.time) {
    state.candles.push(bar);
    if (state.candles.length > 1500) state.candles.shift();
  } else {
    return; // 乱序数据丢弃
  }
  recomputeAndRender({ fitContent: false });
}

// ---------------- 计算 + 渲染 ----------------

function recomputeAndRender({ fitContent }) {
  const candles = state.candles;
  if (candles.length === 0) return;

  state.indicators = computeAll(candles);
  state.signals = generateSignals(candles, state.indicators);

  candleSeries.setData(candles);

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
  renderEventList();

  // 只对已收盘K线上的信号报警，避免盘中反复触发
  const lastTime = candles[candles.length - 1].time;
  alerts.check(
    state.signals.filter((s) => s.time < lastTime),
    state.symbol
  );

  if (fitContent) mainChart.timeScale().fitContent();
}

function renderSubIndicator() {
  for (const s of subSeries) subChart.removeSeries(s);
  subSeries = [];
  const candles = state.candles;
  const ind = state.indicators;
  const toLine = (arr) =>
    candles
      .map((c, i) => (arr[i] !== null ? { time: c.time, value: arr[i] } : null))
      .filter(Boolean);
  const addLine = (color) => {
    const s = subChart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    subSeries.push(s);
    return s;
  };

  switch (state.subIndicator) {
    case 'rsi':
      addLine('#e6b800').setData(toLine(ind.rsi));
      break;
    case 'kdj':
      addLine('#e6b800').setData(toLine(ind.kdj.k));
      addLine('#4d94ff').setData(toLine(ind.kdj.d));
      addLine('#ff7f2a').setData(toLine(ind.kdj.j));
      break;
    case 'dmi':
      addLine('#26a69a').setData(toLine(ind.dmi.pdi));
      addLine('#ef5350').setData(toLine(ind.dmi.mdi));
      addLine('#e6b800').setData(toLine(ind.dmi.adx));
      break;
    case 'obv':
      addLine('#9966ff').setData(toLine(ind.obv));
      break;
  }
}

// ---------------- 标注：信号 + 宏观事件 ----------------

function nearestCandleTime(t) {
  const candles = state.candles;
  if (candles.length === 0) return null;
  if (t < candles[0].time || t > candles[candles.length - 1].time) return null;
  // 二分找到 <= t 的最后一根K线
  let lo = 0;
  let hi = candles.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (candles[mid].time <= t) lo = mid;
    else hi = mid - 1;
  }
  return candles[lo].time;
}

const eventMarkerMap = new Map(); // time -> events[]（供tooltip查询）

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
    for (const evt of getAllEvents(state.liveEvents)) {
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

// 十字光标悬停时显示事件详情
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
  const events = getAllEvents(state.liveEvents).slice().reverse();
  ul.innerHTML = events
    .map((e) => {
      const cat = EVENT_CATEGORIES[e.category];
      const del = e.id.startsWith('c')
        ? `<button class="del" data-id="${e.id}" title="删除">✕</button>`
        : '';
      return (
        `<li>${del}<span class="cat" style="background:${cat.color}">${cat.label}</span>` +
        `${escapeHtml(e.title)}<br><span class="time">${formatTime(e.time)}</span>` +
        (e.note ? `<br><span class="note">${escapeHtml(e.note)}</span>` : '') +
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

// ---------------- 交互绑定 ----------------

$('symbolSelect').addEventListener('change', (e) => {
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

// 可选：配置实时事件接口后自动拉取（每5分钟刷新一次）
const LIVE_EVENTS_API = ''; // 例如 'https://your-server/api/macro-events'
async function refreshLiveEvents() {
  if (!LIVE_EVENTS_API) return;
  state.liveEvents = await fetchLiveEvents(LIVE_EVENTS_API);
  renderMarkers();
  renderEventList();
}
refreshLiveEvents();
setInterval(refreshLiveEvents, 5 * 60 * 1000);

loadSymbol();
