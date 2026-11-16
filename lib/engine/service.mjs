import { closedWeeks, returnOver, splitClosed } from "./bars.mjs";
import { GUIDE, PROS_CONS } from "./catalog.mjs";
import {
  collectNews,
  DataError,
  fetchEarnings,
  fetchEtfFlows,
  fetchMacroCalendar,
  fundingRate,
  krakenBars,
  yahooBars,
  yahooPrivateMark,
} from "./datasources.mjs";
import { compute } from "./indicators.mjs";
import { evaluate } from "./scoring.mjs";
import { formatMDHM, isoOffset, nySessionBounds, SH, weekdayNY } from "./time.mjs";
import { ASSETS, BY_ID, MACRO_NEWS } from "./universe.mjs";

const store = globalThis;
store.__deskCache ??= new Map();
store.__deskInflight ??= new Map();

export async function cached(key, ttlSec, loader) {
  const now = Date.now();
  const hit = store.__deskCache.get(key);
  if (hit && now - hit.at < ttlSec * 1000) return hit.value;
  const pending = store.__deskInflight.get(key);
  if (pending) return pending;
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

async function loadBars(asset, horizon) {
  const mode = asset.modes[horizon];
  return cached(`bars:${asset.id}:${horizon}`, 90, async () => {
    if (asset.source === "yahoo") return yahooBars(asset.yahoo, mode.interval, mode.range);
    if (asset.source === "kraken") return krakenBars(asset.kraken, Number(mode.interval));
    throw new DataError("这个标的没有 K 线源");
  });
}

function calendar() {
  return cached("calendar", 6 * 3600, fetchMacroCalendar);
}

function earningsMap() {
  return cached("earnings", 6 * 3600, async () => {
    const found = {};
    await Promise.all(
      ASSETS.filter((asset) => asset.earnings_symbol).map(async (asset) => {
        try {
          const row = await fetchEarnings(asset.earnings_symbol);
          if (row) found[asset.id] = { ...row, affects: asset.earnings_affects || [asset.id] };
        } catch (error) {
          if (!(error instanceof DataError)) throw error;
        }
      }),
    );
    return found;
  });
}

function flows() {
  return cached("flows", 15 * 60, fetchEtfFlows);
}

function funding(inst) {
  return cached(`funding:${inst}`, 120, () => fundingRate(inst));
}

function newsFor(asset) {
  const queries = [...(asset.news || []), ...MACRO_NEWS];
  return cached(`news:${asset.id}`, 180, () => collectNews(queries, 14));
}

function session(assetClass, now) {
  if (assetClass === "private") return "未上市";
  if (assetClass === "crypto") return "连续交易";
  if (weekdayNY(now) >= 5) return "美股休市";
  const bounds = nySessionBounds(now);
  if (bounds.start <= now && now <= bounds.end) return "美股交易中";
  return "美股休市";
}

async function eventsFor(assetId) {
  const [macro, notes] = await calendar();
  const events = macro.map((event) => ({ ...event }));
  const earnings = await earningsMap();
  for (const [owner, row] of Object.entries(earnings)) {
    if (!row.affects.includes(assetId)) continue;
    const label = row.estimate ? "估计财报日" : "财报日";
    events.push({
      t: row.t,
      kind: "earnings",
      impact: "high",
      title: `${row.symbol} ${label} ${row.date}（美东当天，钟点不是公布时刻）`,
      scope: "micro",
      source: "yahoo / nasdaq",
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
        const bars = await loadBars(asset, "swing");
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

function publicScore(result) {
  if (!result.ok) return { ok: false, reason: result.reason };
  const data = { ...result };
  delete data.pack;
  delete data.decision_index;
  const level = { ...data.invalidation, level: round(data.invalidation.level, 4), atr: round(data.invalidation.atr, 4) };
  if (level.distance_atr != null) level.distance_atr = round(level.distance_atr, 2);
  data.invalidation = level;
  data.signals = data.signals.map((signal) => ({
    ...signal,
    points: signal.points == null ? null : round(signal.points, 1),
    effective_weight: round(signal.effective_weight, 2),
  }));
  const snap = {};
  for (const [key, value] of Object.entries(data.snapshot)) snap[key] = typeof value === "number" ? round(value, 4) : value;
  data.snapshot = snap;
  return data;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function num(value) {
  return value == null ? null : round(Number(value), 6);
}

function chart(full, decisionT) {
  const pack = compute(full);
  const start = Math.max(0, full.length - 180);
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
      bb_up: num(pack.bb_up[i]),
      bb_low: num(pack.bb_low[i]),
      supertrend: num(pack.supertrend[i]),
      st_dir: pack.supertrend_dir[i],
      vwap: num(pack.vwap[i]),
      rsi: num(pack.rsi[i]),
      macd: num(pack.macd[i]),
      macd_signal: num(pack.macd_signal[i]),
      macd_hist: num(pack.macd_hist[i]),
      vol_ma: num(pack.vol_ma[i]),
      decision: bar.t === decisionT,
    });
  }
  return candles;
}

async function analyze(asset, horizon, now, dailyClosed) {
  const mode = asset.modes[horizon];
  const full = await loadBars(asset, horizon);
  const [closed, live] = splitClosed(full, mode.interval_sec, asset.asset_class, now);
  let higher;
  if (horizon === "swing") higher = closedWeeks(await loadBars(asset, "swing"), now);
  else {
    const dailyFull = await loadBars(asset, "swing");
    [higher] = splitClosed(dailyFull, 86400, asset.asset_class, now);
  }
  const [events, notes] = await eventsFor(asset.id);
  const warnings = [...notes];
  let flowRows = null;
  let fundingValue = null;
  if (asset.id === "btc") {
    try {
      flowRows = await flows();
    } catch (error) {
      if (error instanceof DataError) warnings.push(`ETF 资金表暂时不可用：${error.message}`);
      else throw error;
    }
  }
  if (asset.funding) {
    try {
      fundingValue = await funding(asset.funding);
    } catch (error) {
      if (error instanceof DataError) warnings.push(`资金费率暂时不可用：${error.message}`);
      else throw error;
      fundingValue = null;
    }
  }
  const [primary, secondary] = relative(asset, dailyClosed);
  if (asset.rs && primary == null) warnings.push("相对强弱缺少基准收益，这一项本次不投票");
  const result = evaluate(closed, higher, {
    asset_id: asset.id,
    asset_class: asset.asset_class,
    now,
    interval_sec: mode.interval_sec,
    events,
    flows: flowRows,
    funding_rate: fundingValue,
    rs_primary: primary,
    rs_secondary: secondary,
    rs_label: asset.rs?.label,
    higher_name: mode.higher,
  });
  const priceBar = live || (closed.length ? closed[closed.length - 1] : null);
  let prevClose = null;
  if (live != null && closed.length) prevClose = closed[closed.length - 1].c;
  else if (closed.length >= 2) prevClose = closed[closed.length - 2].c;
  return {
    score: publicScore(result),
    candles: chart(full, closed.length ? closed[closed.length - 1].t : null),
    events,
    flows: flowRows ? flowRows.slice(-12) : null,
    funding_rate: fundingValue,
    warnings,
    price: priceBar ? priceBar.c : null,
    change_pct: priceBar && prevClose ? priceBar.c / prevClose - 1 : null,
    decision_t: closed.length ? closed[closed.length - 1].t : null,
    live_bar: live != null,
    horizon_label: mode.label,
    higher_label: mode.higher,
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
  let text = "英伟达、AMD、半导体指数和纳指是同一团行业与风险偏好。它们的动作分同向时，不要把四张卡片加成四笔独立仓位。";
  if (same) text += " 这一轮它们的动作分已经同向，按一笔风险来想。";
  const btc = byId.btc || {};
  const nasdaq = byId.nasdaq || {};
  if (btc.action_score != null && nasdaq.action_score != null) {
    if (btc.action_score * nasdaq.action_score > 0 && Math.abs(btc.action_score) >= 20 && Math.abs(nasdaq.action_score) >= 20) {
      text += " 比特币和纳指目前同向，风险偏好的重叠比平时更高。";
    }
  }
  if (byId.hype?.action_score != null && btc.action_score != null) {
    text += " HYPE 还要单独看它相对比特币的强弱，它不是纳指的替代品。";
  }
  return { text, same_tech_direction: same };
}

function nextTitle(events, now) {
  const future = events.filter((event) => event.t >= now - 6 * 3600);
  if (!future.length) return null;
  const event = future.reduce((best, item) => (item.t < best.t ? item : best));
  return `${event.title} · ${formatMDHM(event.t, SH)} 上海`;
}

export async function board(now = Date.now() / 1000) {
  return cached(`board:${Math.floor(now / 30)}`, 45, () => buildBoard(now));
}

async function buildBoard(now) {
  await Promise.all([calendar(), earningsMap(), ...ASSETS.filter((asset) => asset.tradable).map((asset) => loadBars(asset, "swing").catch((error) => {
    if (error instanceof DataError) return null;
    throw error;
  }))]);
  const dailyClosed = await dailyClosedMap(now);
  const cards = [];
  for (const asset of ASSETS) {
    const card = {
      id: asset.id,
      name: asset.name,
      symbol: asset.symbol,
      pair: asset.pair,
      tradable: asset.tradable,
      asset_class: asset.asset_class,
    };
    if (!asset.tradable) {
      try {
        const mark = await cached("spacex-mark", 300, () => yahooPrivateMark(asset.yahoo));
        card.price = mark.price;
        card.mark_name = mark.name;
      } catch (error) {
        if (error instanceof DataError) card.error = error.message;
        else throw error;
      }
      card.stance_label = "不评分";
      card.session = "未上市";
      try {
        card.next_event = nextTitle((await eventsFor(asset.id))[0], now);
      } catch (error) {
        if (error instanceof DataError) card.next_event = null;
        else throw error;
      }
      cards.push(card);
      continue;
    }
    try {
      const analyzed = await analyze(asset, "swing", now, dailyClosed);
      const score = analyzed.score;
      Object.assign(card, {
        price: analyzed.price,
        change_pct: analyzed.change_pct,
        session: session(asset.asset_class, now),
        action_score: score.action_score,
        direction_score: score.direction_score,
        execution_score: score.execution_score,
        stance_label: score.stance_label || "无读数",
        regime_label: score.regime_label,
        risk_score: score.risk_score,
        next_event: nextTitle(analyzed.events, now),
        error: score.ok ? null : score.reason,
      });
    } catch (error) {
      if (!(error instanceof DataError)) throw error;
      card.error = error.message;
    }
    cards.push(card);
  }
  return { as_of: isoOffset(now, SH), cards, cluster: cluster(cards) };
}

export async function assetView(assetId, horizon = "swing", now = Date.now() / 1000) {
  const asset = BY_ID[assetId];
  if (!asset) throw new KeyError(assetId);
  if (horizon !== "swing" && horizon !== "intraday") horizon = "swing";
  return cached(`asset:${assetId}:${horizon}:${Math.floor(now / 30)}`, 45, () => buildAsset(asset, horizon, now));
}

async function buildAsset(asset, horizon, now) {
  const [events, notes] = await eventsFor(asset.id);
  const [news, newsErrors] = await newsFor(asset);
  const recent = news.filter((item) => item.t >= now - 86400);
  const newsWarnings = newsErrors.length && !news.length ? [`部分新闻源失败：${newsErrors[0]}`] : [];
  const base = {
    id: asset.id,
    name: asset.name,
    symbol: asset.symbol,
    pair: asset.pair,
    tradable: asset.tradable,
    note: asset.note,
    digits: asset.digits,
    session: session(asset.asset_class, now),
    as_of: isoOffset(now, SH),
    events,
    news,
    news_burst: recent.length >= 4,
    warnings: [],
    guide: GUIDE,
    catalog: PROS_CONS,
  };
  if (!asset.tradable) {
    try {
      const mark = await cached("spacex-mark", 300, () => yahooPrivateMark(asset.yahoo));
      base.price = mark.price;
      base.mark = mark;
    } catch (error) {
      if (error instanceof DataError) base.error = error.message;
      else throw error;
    }
    base.score = { ok: false, reason: "未上市，没有连续成交，不算技术指标，也不给做多或做空分。" };
    base.warnings = [...notes, ...newsWarnings];
    return base;
  }
  const selected = asset.modes[horizon] ? horizon : "swing";
  const dailyClosed = await dailyClosedMap(now);
  try {
    const analyzed = await analyze(asset, selected, now, dailyClosed);
    Object.assign(base, analyzed);
    const merged = [...analyzed.warnings, ...newsWarnings];
    if (recent.length >= 4) merged.push("过去 24 小时相关新闻较密。标题没有计入分数，先读完再决定要不要把技术读数作废。");
    base.warnings = [...new Set(merged)];
    base.horizon = selected;
    return base;
  } catch (error) {
    if (!(error instanceof DataError)) throw error;
    base.error = error.message;
    base.score = { ok: false, reason: error.message };
    base.warnings = [...notes, ...newsWarnings];
    return base;
  }
}

export class KeyError extends Error {}

export { BY_ID };
