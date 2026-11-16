import { closedWeeks, returnOver, splitClosed, toEquity4h } from "./bars.mjs";
import { GUIDE, PROS_CONS } from "./catalog.mjs";
import {
  binanceBars,
  collectNews,
  DataError,
  fastFallbackCalendar,
  fetchEarnings,
  fetchEarningsFast,
  fetchEtfFlows,
  fetchMacroCalendar,
  fundingRate,
  hyperliquidBars,
  krakenBars,
  mergeBarsByTime,
  yahooBars,
} from "./datasources.mjs";
import { compute } from "./indicators.mjs";
import { evaluate, SCORE_LEGEND } from "./scoring.mjs";
import { formatMDHM, isoOffset, nySessionBounds, SH, weekdayNY } from "./time.mjs";
import { ASSETS, BY_ID, HORIZONS, HORIZON_ORDER, MACRO_NEWS, normalizeHorizon } from "./universe.mjs";

const store = globalThis;
store.__deskCache ??= new Map();
store.__deskInflight ??= new Map();

function triggerRefresh(key, loader) {
  const existing = store.__deskInflight.get(key);
  if (existing) return existing;
  const job = Promise.resolve()
    .then(loader)
    .then((value) => {
      store.__deskCache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      if (store.__deskInflight.get(key) === job) store.__deskInflight.delete(key);
    });
  store.__deskInflight.set(key, job);
  return job;
}

export async function cached(key, freshSec, loader, staleSec = Math.max(freshSec * 10, 600)) {
  const now = Date.now();
  const hit = store.__deskCache.get(key);
  if (hit) {
    const ageMs = now - hit.at;
    if (ageMs < freshSec * 1000) return hit.value;
    if (ageMs < staleSec * 1000) {
      triggerRefresh(key, loader).catch(() => {});
      return hit.value;
    }
  }
  return triggerRefresh(key, loader);
}

async function loadCryptoBars(asset, horizon) {
  let primary = null;
  try {
    primary = await binanceBars(asset.binance, horizon, 420);
  } catch (error) {
    if (!(error instanceof DataError)) throw error;
  }
  if (primary && primary.length >= 210) return primary;

  if (asset.hyperliquid) {
    try {
      const lookback = horizon === "1w" ? 900 : horizon === "1d" ? 760 : horizon === "4h" ? 180 : 60;
      const hl = await hyperliquidBars(asset.hyperliquid, horizon, lookback);
      const merged = mergeBarsByTime(hl, primary);
      if (merged.length >= 10) return merged.slice(-450);
    } catch (error) {
      if (!(error instanceof DataError)) throw error;
    }
  }
  if (primary && primary.length >= 10) return primary;

  if (asset.yahoo) {
    const map = {
      "5m": ["5m", "10d"],
      "15m": ["15m", "60d"],
      "1h": ["60m", "6mo"],
      "4h": ["60m", "6mo"],
      "1d": ["1d", "2y"],
      "1w": ["1wk", "5y"],
    };
    const [iv, rg] = map[horizon];
    const raw = await yahooBars(asset.yahoo, iv, rg);
    return horizon === "4h" ? toEquity4h(raw) : raw.slice(-450);
  }
  if (asset.kraken) {
    const kMap = { "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080 };
    return krakenBars(asset.kraken, kMap[horizon]);
  }
  throw new DataError("这个标的暂时没有可用 K 线源");
}

function loadYahooHourly(symbol) {
  return cached(`yahoo60m:${symbol}`, 45, () => yahooBars(symbol, "60m", "6mo"));
}

async function loadEquityBars(asset, horizon) {
  if (horizon === "5m") return (await yahooBars(asset.yahoo, "5m", "10d")).slice(-420);
  if (horizon === "15m") return (await yahooBars(asset.yahoo, "15m", "60d")).slice(-420);
  if (horizon === "1h") return (await loadYahoo60mSlice(asset.yahoo)).slice(-420);
  if (horizon === "4h") return toEquity4h(await loadYahooHourly(asset.yahoo)).slice(-420);
  if (horizon === "1d") return (await yahooBars(asset.yahoo, "1d", "2y")).slice(-520);
  if (horizon === "1w") return (await yahooBars(asset.yahoo, "1wk", "5y")).slice(-320);
  throw new DataError("未知的 K 线周期");
}

async function loadYahoo60mSlice(symbol) {
  return loadYahooHourly(symbol);
}

export async function loadBars(asset, horizonKey) {
  const ttl = horizonKey === "5m" || horizonKey === "15m" ? 25 : 45;
  return cached(`bars:${asset.id}:${horizonKey}`, ttl, () =>
    asset.source === "binance" ? loadCryptoBars(asset, horizonKey) : loadEquityBars(asset, horizonKey),
  );
}

function calendar() {
  const hit = store.__deskCache.get("calendar");
  if (!hit) {
    triggerRefresh("calendar", fetchMacroCalendar).catch(() => {});
    return Promise.resolve(fastFallbackCalendar());
  }
  return cached("calendar", 6 * 3600, fetchMacroCalendar, 24 * 3600);
}

async function loadEarnings(includeYahooFallback) {
  const found = {};
  await Promise.all(
    ASSETS.filter((asset) => asset.earnings_symbol).map(async (asset) => {
      try {
        const row = includeYahooFallback
          ? await fetchEarnings(asset.earnings_symbol)
          : await fetchEarningsFast(asset.earnings_symbol);
        if (row) found[asset.id] = { ...row, affects: asset.earnings_affects || [asset.id] };
      } catch (error) {
        if (!(error instanceof DataError)) throw error;
      }
    }),
  );
  return found;
}

function earningsMap() {
  const hit = store.__deskCache.get("earnings");
  if (!hit) {
    return cached("earnings", 4 * 3600, async () => {
      const fast = await loadEarnings(false);
      setTimeout(() => {
        loadEarnings(true)
          .then((full) => {
            if (Object.keys(full).length >= Object.keys(fast).length) {
              store.__deskCache.set("earnings", { at: Date.now(), value: full });
            }
          })
          .catch(() => {});
      }, 2500).unref?.();
      return fast;
    }, 18 * 3600);
  }
  return cached("earnings", 4 * 3600, () => loadEarnings(true), 18 * 3600);
}

function flows() {
  return cached("flows", 15 * 60, fetchEtfFlows, 6 * 3600);
}

function funding(inst) {
  return cached(`funding:${inst}`, 90, () => fundingRate(inst), 1800);
}

function newsFor(asset) {
  const queries = [...(asset.news || []), MACRO_NEWS[0]];
  return cached(`news:${asset.id}`, 240, () => collectNews(queries, 12), 3600);
}

async function fastNewsFor(asset) {
  const key = `news:${asset.id}`;
  const hit = store.__deskCache.get(key);
  if (hit) {
    if (Date.now() - hit.at >= 240_000) newsFor(asset).catch(() => {});
    return hit.value;
  }
  const job = newsFor(asset);
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 2200));
  const raced = await Promise.race([job, timeout]);
  return raced ?? [[], []];
}

function session(assetClass, now) {
  if (assetClass === "private") return "未上市";
  if (assetClass === "crypto") return "24h 实时连续交易";
  if (weekdayNY(now) >= 5) return "美股休市（周末）";
  const bounds = nySessionBounds(now);
  if (bounds.start <= now && now <= bounds.end) return "美股盘中交易";
  return "美股盘后/休市";
}

async function eventsFor(assetId) {
  const [[macro, notes], earnings] = await Promise.all([calendar(), earningsMap()]);
  const events = macro.map((event) => ({ ...event }));
  for (const [owner, row] of Object.entries(earnings)) {
    if (!row.affects.includes(assetId)) continue;
    const label = row.estimate ? "预计财报日" : "财报发布日";
    events.push({
      t: row.t,
      kind: "earnings",
      impact: "high",
      title: `${row.symbol} ${label} ${row.date}`,
      scope: "micro",
      source: "Nasdaq / Yahoo",
      estimate: row.estimate,
      owner,
    });
  }
  events.sort((a, b) => a.t - b.t);
  return [events, notes];
}

async function dailyClosedMap(now) {
  const closed = {};
  await Promise.all(
    ASSETS.filter((asset) => asset.tradable).map(async (asset) => {
      try {
        const bars = await loadBars(asset, "1d");
        const [done] = splitClosed(bars, 86400, asset.asset_class, now);
        closed[asset.id] = done;
      } catch (error) {
        if (!(error instanceof DataError)) throw error;
      }
    }),
  );
  return closed;
}

function relative(asset, dailyClosed) {
  if (!asset.rs) return [null, null];
  const delta = (otherId) => {
    if (!otherId) return null;
    const own = returnOver(dailyClosed[asset.id] || [], 20);
    const other = returnOver(dailyClosed[otherId] || [], 20);
    if (own == null || other == null) return null;
    return own - other;
  };
  return [delta(asset.rs.primary), delta(asset.rs.secondary)];
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function num(value) {
  return value == null || !Number.isFinite(Number(value)) ? null : round(Number(value), 6);
}

function publicScore(result) {
  if (!result.ok) return { ok: false, reason: result.reason, score_legend: SCORE_LEGEND };
  const data = { ...result };
  delete data.pack;
  delete data.decision_index;
  const level = {
    ...data.invalidation,
    level: round(data.invalidation.level, 4),
    atr: round(data.invalidation.atr, 4),
  };
  if (level.distance_atr != null) level.distance_atr = round(level.distance_atr, 2);
  data.invalidation = level;
  data.signals = data.signals.map((signal) => ({
    ...signal,
    points: signal.points == null ? null : round(signal.points, 1),
    effective_weight: round(signal.effective_weight, 2),
  }));
  const snap = {};
  for (const [key, value] of Object.entries(data.snapshot)) {
    snap[key] = typeof value === "number" ? round(value, 4) : value;
  }
  data.snapshot = snap;
  return data;
}

function chart(full, decisionT) {
  const pack = compute(full);
  const start = Math.max(0, full.length - 320);
  const candles = [];
  for (let i = start; i < full.length; i += 1) {
    const bar = full[i];
    candles.push({
      t: bar.t,
      o: num(bar.o),
      h: num(bar.h),
      l: num(bar.l),
      c: num(bar.c),
      v: num(bar.v),
      ema20: num(pack.ema20[i]),
      ema50: num(pack.ema50[i]),
      ema200: num(pack.ema200[i]),
      bbi: num(pack.bbi[i]),
      bb_mid: num(pack.bb_mid[i]),
      bb_up: num(pack.bb_up[i]),
      bb_low: num(pack.bb_low[i]),
      supertrend: num(pack.supertrend[i]),
      st_dir: pack.supertrend_dir[i],
      vwap: num(pack.vwap[i]),
      rsi: num(pack.rsi[i]),
      macd: num(pack.macd[i]),
      macd_signal: num(pack.macd_signal[i]),
      macd_hist: num(pack.macd_hist[i]),
      k: num(pack.k[i]),
      d: num(pack.d[i]),
      j: num(pack.j[i]),
      adx: num(pack.adx[i]),
      plus_di: num(pack.plus_di[i]),
      minus_di: num(pack.minus_di[i]),
      obv: num(pack.obv[i]),
      vol_ma: num(pack.vol_ma[i]),
      decision: bar.t === decisionT,
    });
  }
  return candles;
}

async function loadHigherClosed(asset, meta, now) {
  if (!meta.higher) return null;
  if (meta.higher === "1w") {
    const daily = await loadBars(asset, "1d");
    return closedWeeks(daily, now);
  }
  const raw = await loadBars(asset, meta.higher);
  const higherSec = HORIZONS[meta.higher].interval_sec;
  const [done] = splitClosed(raw, higherSec, asset.asset_class, now);
  return done;
}

async function analyze(asset, horizonKey, now, dailyClosed) {
  const meta = HORIZONS[horizonKey];
  const [full, higher, [events, notes], flowRows, fundingValue] = await Promise.all([
    loadBars(asset, horizonKey),
    loadHigherClosed(asset, meta, now).catch(() => null),
    eventsFor(asset.id),
    asset.id === "btc"
      ? flows().catch((err) => ({ __err: err instanceof DataError ? err.message : "不可用" }))
      : Promise.resolve(null),
    asset.funding
      ? funding(asset.funding).catch((err) => ({ __err: err instanceof DataError ? err.message : "不可用" }))
      : Promise.resolve(null),
  ]);

  const [closed, live] = splitClosed(full, meta.interval_sec, asset.asset_class, now);
  const warnings = [...notes];
  let cleanFlows = null;
  if (flowRows && !flowRows.__err) cleanFlows = flowRows;
  else if (flowRows?.__err) warnings.push(`比特币现货 ETF 净流暂未刷新：${flowRows.__err}`);

  let cleanFunding = null;
  if (typeof fundingValue === "number") cleanFunding = fundingValue;
  else if (fundingValue?.__err) warnings.push(`永续资金费率暂未刷新：${fundingValue.__err}`);

  const [primary, secondary] = relative(asset, dailyClosed);
  if (asset.rs && primary == null) warnings.push("相对强弱缺少基准样本，本次暂不计分");

  const result = evaluate(closed, higher, {
    asset_id: asset.id,
    asset_class: asset.asset_class,
    now,
    interval_sec: meta.interval_sec,
    events,
    flows: cleanFlows,
    funding_rate: cleanFunding,
    rs_primary: primary,
    rs_secondary: secondary,
    rs_label: asset.rs?.label,
    higher_name: meta.higher_label,
  });

  const priceBar = live || (closed.length ? closed[closed.length - 1] : null);
  let prevClose = null;
  if (live != null && closed.length) prevClose = closed[closed.length - 1].c;
  else if (closed.length >= 2) prevClose = closed[closed.length - 2].c;

  return {
    score: publicScore(result),
    candles: chart(full, closed.length ? closed[closed.length - 1].t : null),
    events,
    flows: cleanFlows ? cleanFlows.slice(-14) : null,
    funding_rate: cleanFunding,
    warnings,
    price: priceBar ? priceBar.c : null,
    change_pct: priceBar && prevClose ? priceBar.c / prevClose - 1 : null,
    decision_t: closed.length ? closed[closed.length - 1].t : null,
    live_bar: live != null,
    horizon: horizonKey,
    horizon_label: meta.label,
    horizon_full_label: meta.full_label,
    higher_label: meta.higher_label,
    interval_sec: meta.interval_sec,
  };
}

function cluster(cards) {
  const byId = Object.fromEntries(cards.map((card) => [card.id, card]));
  const signed = [];
  for (const assetId of ["nvda", "amd", "sox", "nasdaq"]) {
    const score = byId[assetId]?.action_score;
    if (score == null || Math.abs(score) < 20) continue;
    signed.push([assetId, score]);
  }
  const same = signed.length >= 3 && new Set(signed.map(([, score]) => (score > 0 ? 1 : -1))).size === 1;
  let text = "组合相关性风控：英伟达、AMD、半导体指数与纳指高度同源。四者同向时代表同一股 AI/科技流动性风险，切勿把四张卡片叠加成四倍仓位。";
  if (same) text += " 当前科技板块已出现同向共振，请按单一风险敞口统筹仓位。";
  const btc = byId.btc || {};
  const nasdaq = byId.nasdaq || {};
  if (btc.action_score != null && nasdaq.action_score != null) {
    if (btc.action_score * nasdaq.action_score > 0 && Math.abs(btc.action_score) >= 20 && Math.abs(nasdaq.action_score) >= 20) {
      text += " 比特币与纳指当前方向高度同步，跨市场风险资产相关性处于高位。";
    }
  }
  return { text, same_tech_direction: same };
}

function nextTitle(events, now) {
  const future = events.filter((event) => event.t >= now - 6 * 3600);
  if (!future.length) return null;
  const event = future.reduce((best, item) => (item.t < best.t ? item : best));
  return `${event.title} · ${formatMDHM(event.t, SH)} 上海`;
}

function warmBackground() {
  for (const asset of ASSETS) {
    newsFor(asset).catch(() => {});
  }
}

export async function board(now = Date.now() / 1000) {
  return cached("board:v2", 30, () => buildBoard(now), 900);
}

async function buildBoard(now) {
  const dailyClosed = await dailyClosedMap(now);
  const cards = await Promise.all(
    ASSETS.map(async (asset) => {
      const card = {
        id: asset.id,
        name: asset.name,
        symbol: asset.symbol,
        pair: asset.pair,
        tradable: asset.tradable,
        asset_class: asset.asset_class,
        digits: asset.digits,
      };
      try {
        const analyzed = await analyze(asset, "1d", now, dailyClosed);
        const score = analyzed.score;
        Object.assign(card, {
          price: analyzed.price,
          change_pct: analyzed.change_pct,
          session: session(asset.asset_class, now),
          action_score: score.action_score,
          direction_score: score.direction_score,
          execution_score: score.execution_score,
          stance_label: score.stance_label || "周期样本不足",
          verdict_title: score.playbook?.verdict_title || score.stance_label,
          regime_label: score.regime_label,
          risk_score: score.risk_score,
          next_event: nextTitle(analyzed.events, now),
          error: score.ok ? null : score.reason,
        });
      } catch (error) {
        if (!(error instanceof DataError)) throw error;
        card.error = error.message;
      }
      return card;
    }),
  );
  warmBackground();
  return {
    as_of: isoOffset(now, SH),
    horizons: HORIZON_ORDER.map((key) => HORIZONS[key]),
    score_legend: SCORE_LEGEND,
    cards,
    cluster: cluster(cards),
  };
}

export async function assetView(assetId, horizon = "1d", now = Date.now() / 1000) {
  const asset = BY_ID[assetId];
  if (!asset) throw new KeyError(assetId);
  const horizonKey = normalizeHorizon(horizon) || "1d";
  const ttl = horizonKey === "5m" || horizonKey === "15m" ? 20 : 35;
  return cached(`asset:v2:${assetId}:${horizonKey}`, ttl, () => buildAsset(asset, horizonKey, now), 900);
}

async function buildAsset(asset, horizonKey, now) {
  const [[events], [news, newsErrors], dailyClosed] = await Promise.all([
    eventsFor(asset.id),
    fastNewsFor(asset),
    dailyClosedMap(now),
  ]);
  const recent = news.filter((item) => item.t >= now - 86400);
  const newsWarnings = newsErrors.length && !news.length ? [`部分新闻源暂缓：${newsErrors[0]}`] : [];
  const base = {
    id: asset.id,
    name: asset.name,
    symbol: asset.symbol,
    pair: asset.pair,
    asset_class: asset.asset_class,
    source_name: asset.source === "binance" ? "Binance 现货 + 实时流" : "Nasdaq / Yahoo 复权行情",
    ws_symbol: asset.ws_symbol || null,
    tv_symbol: asset.tv_symbol || null,
    ipo_date: asset.ipo_date || null,
    ipo_price: asset.ipo_price || null,
    tradable: asset.tradable,
    note: asset.note,
    digits: asset.digits,
    session: session(asset.asset_class, now),
    as_of: isoOffset(now, SH),
    horizons: HORIZON_ORDER.map((key) => HORIZONS[key]),
    events,
    news,
    news_burst: recent.length >= 4,
    warnings: [],
    guide: GUIDE,
    catalog: PROS_CONS,
  };
  try {
    const analyzed = await analyze(asset, horizonKey, now, dailyClosed);
    Object.assign(base, analyzed);
    const merged = [...analyzed.warnings, ...newsWarnings];
    if (recent.length >= 4) {
      merged.push("过去 24 小时该标的相关新闻密集发布。突发新闻不会自动计入技术分，操作前请务必先核对下方新闻正文。");
    }
    base.warnings = [...new Set(merged)];
    return base;
  } catch (error) {
    if (!(error instanceof DataError)) throw error;
    base.error = error.message;
    base.score = { ok: false, reason: error.message, score_legend: SCORE_LEGEND };
    base.warnings = newsWarnings;
    return base;
  }
}

export class KeyError extends Error {}

export { BY_ID, HORIZONS, HORIZON_ORDER, normalizeHorizon };
