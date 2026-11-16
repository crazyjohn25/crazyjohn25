"""Build the board and a single-asset readout from public market data."""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from .bars import closed_weeks, return_over, split_closed, to_equity_4h
from .catalog import GUIDE, PROS_CONS
from .datasources import (
    DataError,
    binance_bars,
    collect_news,
    fast_fallback_calendar,
    fetch_earnings_fast,
    fetch_etf_flows,
    fetch_macro_calendar,
    funding_rate,
    hyperliquid_bars,
    kraken_bars,
    merge_bars_by_time,
    yahoo_bars,
)
from .indicators import compute
from .scoring import evaluate
from .universe import ASSETS, BY_ID, HORIZONS, HORIZON_ORDER, MACRO_NEWS, normalize_horizon

NY = ZoneInfo("America/New_York")
SH = ZoneInfo("Asia/Shanghai")

_CACHE: dict[str, tuple[float, object]] = {}
_INFLIGHT: set[str] = set()
_LOCK = threading.Lock()


def _refresh_bg(key: str, loader) -> None:
    def run():
        try:
            val = loader()
            with _LOCK:
                _CACHE[key] = (time.time(), val)
        except Exception:
            pass
        finally:
            with _LOCK:
                _INFLIGHT.discard(key)

    with _LOCK:
        if key in _INFLIGHT:
            return
        _INFLIGHT.add(key)
    threading.Thread(target=run, daemon=True).start()


def cached(key: str, fresh_ttl: float, loader, stale_ttl: float = 900.0):
    now = time.time()
    with _LOCK:
        hit = _CACHE.get(key)
    if hit:
        age = now - hit[0]
        if age < fresh_ttl:
            return hit[1]
        if age < stale_ttl:
            _refresh_bg(key, loader)
            return hit[1]
    value = loader()
    with _LOCK:
        _CACHE[key] = (time.time(), value)
    return value


def clear_cache() -> None:
    with _LOCK:
        _CACHE.clear()


def _load_crypto_bars(asset: dict, horizon: str) -> list[dict]:
    primary = None
    try:
        primary = binance_bars(asset["binance"], horizon, 420)
    except DataError:
        primary = None
    if primary and len(primary) >= 210:
        return primary
    if asset.get("hyperliquid"):
        try:
            days = 900 if horizon == "1w" else (760 if horizon == "1d" else 180)
            hl = hyperliquid_bars(asset["hyperliquid"], horizon, days)
            merged = merge_bars_by_time(hl, primary)
            if len(merged) >= 10:
                return merged[-450:]
        except DataError:
            pass
    if primary and len(primary) >= 10:
        return primary
    if asset.get("yahoo"):
        y_map = {"5m": ("5m", "10d"), "15m": ("15m", "60d"), "1h": ("60m", "6mo"), "4h": ("60m", "6mo"), "1d": ("1d", "2y"), "1w": ("1wk", "5y")}
        iv, rg = y_map[horizon]
        raw = yahoo_bars(asset["yahoo"], iv, rg)
        return to_equity_4h(raw) if horizon == "4h" else raw[-450:]
    if asset.get("kraken"):
        k_map = {"5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080}
        return kraken_bars(asset["kraken"], k_map[horizon])
    raise DataError("这个标的没有可用 K 线源")


def _load_equity_bars(asset: dict, horizon: str) -> list[dict]:
    sym = asset["yahoo"]
    if horizon == "5m":
        return yahoo_bars(sym, "5m", "10d")[-420:]
    if horizon == "15m":
        return yahoo_bars(sym, "15m", "60d")[-420:]
    if horizon == "1h":
        return cached(f"y60m:{sym}", 45, lambda: yahoo_bars(sym, "60m", "6mo"))[-420:]
    if horizon == "4h":
        hourly = cached(f"y60m:{sym}", 45, lambda: yahoo_bars(sym, "60m", "6mo"))
        return to_equity_4h(hourly)[-420:]
    if horizon == "1d":
        return yahoo_bars(sym, "1d", "2y")[-520:]
    if horizon == "1w":
        return yahoo_bars(sym, "1wk", "5y")[-320:]
    raise DataError("未知周期")


def _load_bars(asset: dict, horizon: str) -> list[dict]:
    ttl = 25 if horizon in ("5m", "15m") else 45
    loader = (lambda: _load_crypto_bars(asset, horizon)) if asset["source"] == "binance" else (lambda: _load_equity_bars(asset, horizon))
    return cached(f"bars:{asset['id']}:{horizon}", ttl, loader)


def _calendar():
    with _LOCK:
        hit = _CACHE.get("calendar")
    if not hit:
        _refresh_bg("calendar", fetch_macro_calendar)
        return fast_fallback_calendar()
    return cached("calendar", 6 * 3600, fetch_macro_calendar, 24 * 3600)


def _earnings_map() -> dict[str, dict]:
    def load():
        found = {}
        targets = [a for a in ASSETS if a.get("earnings_symbol")]
        with ThreadPoolExecutor(max_workers=4) as pool:
            futs = [(a, pool.submit(fetch_earnings_fast, a["earnings_symbol"])) for a in targets]
            for asset, fut in futs:
                try:
                    row = fut.result()
                except Exception:
                    row = None
                if row:
                    found[asset["id"]] = {**row, "affects": asset.get("earnings_affects") or [asset["id"]]}
        return found

    return cached("earnings", 4 * 3600, load, 18 * 3600)


def _flows():
    return cached("flows", 15 * 60, fetch_etf_flows, 6 * 3600)


def _funding(inst: str):
    return cached(f"funding:{inst}", 90, lambda: funding_rate(inst), 1800)


def _news(asset: dict):
    queries = list(asset.get("news") or []) + [MACRO_NEWS[0]]
    return cached(f"news:{asset['id']}", 240, lambda: collect_news(queries, 12), 3600)


def _session(asset_class: str, now: float) -> str:
    if asset_class == "private":
        return "未上市"
    if asset_class == "crypto":
        return "24h 实时连续交易"
    dt = datetime.fromtimestamp(now, NY)
    if dt.weekday() >= 5:
        return "美股休市（周末）"
    start = dt.replace(hour=9, minute=30, second=0, microsecond=0)
    end = dt.replace(hour=16, minute=0, second=0, microsecond=0)
    if start.timestamp() <= now <= end.timestamp():
        return "美股盘中交易"
    return "美股盘后/休市"


def _events_for(asset_id: str) -> tuple[list[dict], list[str]]:
    macro, notes = _calendar()
    events = [dict(event) for event in macro]
    for owner, row in _earnings_map().items():
        if asset_id not in row["affects"]:
            continue
        label = "预计财报日" if row["estimate"] else "财报发布日"
        events.append(
            {
                "t": row["t"],
                "kind": "earnings",
                "impact": "high",
                "title": f"{row['symbol']} {label} {row['date']}",
                "scope": "micro",
                "source": "Nasdaq / Yahoo",
                "estimate": row["estimate"],
                "owner": owner,
            }
        )
    events.sort(key=lambda event: event["t"])
    return events, notes


def _rs(asset: dict, daily_closed: dict[str, list[dict]]) -> tuple[float | None, float | None]:
    spec = asset.get("rs")
    if not spec:
        return None, None

    def delta(other_id: str | None) -> float | None:
        if not other_id:
            return None
        own = return_over(daily_closed.get(asset["id"]) or [], 20)
        other = return_over(daily_closed.get(other_id) or [], 20)
        if own is None or other is None:
            return None
        return own - other

    return delta(spec.get("primary")), delta(spec.get("secondary"))


def _public_score(result: dict) -> dict:
    if not result.get("ok"):
        return {"ok": False, "reason": result.get("reason")}
    hidden = {"pack", "decision_index"}
    data = {key: value for key, value in result.items() if key not in hidden}
    level = dict(data["invalidation"])
    level["level"] = round(level["level"], 4)
    level["atr"] = round(level["atr"], 4)
    if level.get("distance_atr") is not None:
        level["distance_atr"] = round(level["distance_atr"], 2)
    data["invalidation"] = level
    for signal in data["signals"]:
        if signal.get("points") is not None:
            signal["points"] = round(signal["points"], 1)
        signal["effective_weight"] = round(signal["effective_weight"], 2)
    snap = {}
    for key, value in data["snapshot"].items():
        snap[key] = round(value, 4) if isinstance(value, float) else value
    data["snapshot"] = snap
    return data


def _chart(full: list[dict], decision_t: int | None) -> list[dict]:
    pack = compute(full)
    start = max(0, len(full) - 320)
    candles = []
    for i in range(start, len(full)):
        bar = full[i]

        def num(value):
            return None if value is None else round(float(value), 6)

        candles.append(
            {
                "t": bar["t"],
                "o": num(bar["o"]),
                "h": num(bar["h"]),
                "l": num(bar["l"]),
                "c": num(bar["c"]),
                "v": num(bar["v"]),
                "ema20": num(pack["ema20"][i]),
                "ema50": num(pack["ema50"][i]),
                "ema200": num(pack["ema200"][i]),
                "bbi": num(pack["bbi"][i]),
                "bb_mid": num(pack["bb_mid"][i]),
                "bb_up": num(pack["bb_up"][i]),
                "bb_low": num(pack["bb_low"][i]),
                "supertrend": num(pack["supertrend"][i]),
                "st_dir": pack["supertrend_dir"][i],
                "vwap": num(pack["vwap"][i]),
                "rsi": num(pack["rsi"][i]),
                "macd": num(pack["macd"][i]),
                "macd_signal": num(pack["macd_signal"][i]),
                "macd_hist": num(pack["macd_hist"][i]),
                "k": num(pack["k"][i]),
                "d": num(pack["d"][i]),
                "j": num(pack["j"][i]),
                "adx": num(pack["adx"][i]),
                "plus_di": num(pack["plus_di"][i]),
                "minus_di": num(pack["minus_di"][i]),
                "obv": num(pack["obv"][i]),
                "vol_ma": num(pack["vol_ma"][i]),
                "decision": bar["t"] == decision_t,
            }
        )
    return candles


def _load_higher(asset: dict, meta: dict, now: float) -> list[dict] | None:
    higher_key = meta["higher"]
    if not higher_key:
        return None
    if higher_key == "1w":
        return closed_weeks(_load_bars(asset, "1d"), now)
    raw = _load_bars(asset, higher_key)
    done, _ = split_closed(raw, HORIZONS[higher_key]["interval_sec"], asset["asset_class"], now)
    return done


def _analyze(asset: dict, horizon_key: str, now: float, daily_closed: dict[str, list[dict]]) -> dict:
    meta = HORIZONS[horizon_key]
    full = _load_bars(asset, horizon_key)
    closed, live = split_closed(full, meta["interval_sec"], asset["asset_class"], now)
    try:
        higher = _load_higher(asset, meta, now)
    except DataError:
        higher = None
    events, notes = _events_for(asset["id"])
    flows = None
    funding = None
    warnings = list(notes)
    if asset["id"] == "btc":
        try:
            flows = _flows()
        except DataError as exc:
            warnings.append(f"ETF 资金表暂时不可用：{exc}")
    if asset.get("funding"):
        try:
            funding = _funding(asset["funding"])
        except DataError as exc:
            warnings.append(f"资金费率暂时不可用：{exc}")
    primary, secondary = _rs(asset, daily_closed)
    if asset.get("rs") and primary is None:
        warnings.append("相对强弱缺少基准收益，这一项本次不投票")
    context = {
        "asset_id": asset["id"],
        "asset_class": asset["asset_class"],
        "now": now,
        "interval_sec": meta["interval_sec"],
        "events": events,
        "flows": flows,
        "funding_rate": funding,
        "rs_primary": primary,
        "rs_secondary": secondary,
        "rs_label": (asset.get("rs") or {}).get("label"),
        "higher_name": meta["higher_label"],
    }
    result = evaluate(closed, higher, context)
    price_bar = live or (closed[-1] if closed else None)
    prev_close = None
    if live is not None and closed:
        prev_close = closed[-1]["c"]
    elif len(closed) >= 2:
        prev_close = closed[-2]["c"]
    change = (price_bar["c"] / prev_close - 1) if (price_bar and prev_close) else None
    return {
        "score": _public_score(result),
        "candles": _chart(full, closed[-1]["t"] if closed else None),
        "events": events,
        "flows": flows[-14:] if flows else None,
        "funding_rate": funding,
        "warnings": warnings,
        "price": None if price_bar is None else price_bar["c"],
        "change_pct": change,
        "decision_t": closed[-1]["t"] if closed else None,
        "live_bar": live is not None,
        "horizon": horizon_key,
        "horizon_label": meta["label"],
        "horizon_full_label": meta["full_label"],
        "higher_label": meta["higher_label"],
        "interval_sec": meta["interval_sec"],
    }


def _daily_closed_map(now: float) -> dict[str, list[dict]]:
    closed = {}
    targets = [a for a in ASSETS if a["tradable"]]
    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = [(a, pool.submit(_load_bars, a, "1d")) for a in targets]
        for asset, fut in futs:
            try:
                bars = fut.result()
            except DataError:
                continue
            done, _ = split_closed(bars, 86400, asset["asset_class"], now)
            closed[asset["id"]] = done
    return closed


def _cluster(cards: list[dict]) -> dict:
    by_id = {card["id"]: card for card in cards}
    signed = []
    for asset_id in ["nvda", "amd", "sox", "nasdaq"]:
        score = (by_id.get(asset_id) or {}).get("action_score")
        if score is None or abs(score) < 20:
            continue
        signed.append((asset_id, score))
    same = len(signed) >= 3 and len({1 if score > 0 else -1 for _, score in signed}) == 1
    text = "组合相关性风控：英伟达、AMD、半导体指数与纳指高度同源。四者同向时代表同一股 AI/科技流动性风险，切勿把四张卡片叠加成四倍仓位。"
    if same:
        text += " 当前科技板块已出现同向共振，请按单一风险敞口统筹仓位。"
    return {"text": text, "same_tech_direction": same}


def _next_title(events: list[dict], now: float) -> str | None:
    future = [event for event in events if event["t"] >= now - 6 * 3600]
    if not future:
        return None
    event = min(future, key=lambda item: item["t"])
    when = datetime.fromtimestamp(event["t"], SH).strftime("%m-%d %H:%M")
    return f"{event['title']} · {when} 上海"


def board(now: float | None = None) -> dict:
    now_val = time.time() if now is None else now
    return cached("board:v2", 30, lambda: _build_board(now_val), 900)


def _build_board(now: float) -> dict:
    daily_closed = _daily_closed_map(now)

    def make_card(asset: dict) -> dict:
        card = {
            "id": asset["id"],
            "name": asset["name"],
            "symbol": asset["symbol"],
            "pair": asset["pair"],
            "tradable": asset["tradable"],
            "asset_class": asset["asset_class"],
            "digits": asset["digits"],
        }
        try:
            analyzed = _analyze(asset, "1d", now, daily_closed)
            score = analyzed["score"]
            card.update(
                {
                    "price": analyzed["price"],
                    "change_pct": analyzed["change_pct"],
                    "session": _session(asset["asset_class"], now),
                    "action_score": score.get("action_score"),
                    "direction_score": score.get("direction_score"),
                    "execution_score": score.get("execution_score"),
                    "stance_label": score.get("stance_label") or "周期样本不足",
                    "verdict_title": (score.get("playbook") or {}).get("verdict_title") or score.get("stance_label"),
                    "regime_label": score.get("regime_label"),
                    "risk_score": score.get("risk_score"),
                    "next_event": _next_title(analyzed["events"], now),
                    "error": None if score.get("ok") else score.get("reason"),
                }
            )
        except DataError as exc:
            card["error"] = str(exc)
        return card

    with ThreadPoolExecutor(max_workers=8) as pool:
        cards = list(pool.map(make_card, ASSETS))

    return {
        "as_of": datetime.fromtimestamp(now, SH).isoformat(),
        "horizons": [HORIZONS[k] for k in HORIZON_ORDER],
        "cards": cards,
        "cluster": _cluster(cards),
    }


def asset_view(asset_id: str, horizon: str = "1d", now: float | None = None) -> dict:
    asset = BY_ID.get(asset_id)
    if asset is None:
        raise KeyError(asset_id)
    horizon_key = normalize_horizon(horizon) or "1d"
    now_val = time.time() if now is None else now
    ttl = 20 if horizon_key in ("5m", "15m") else 35
    return cached(f"asset:v2:{asset_id}:{horizon_key}", ttl, lambda: _build_asset(asset, horizon_key, now_val), 900)


def _build_asset(asset: dict, horizon_key: str, now: float) -> dict:
    events, notes = _events_for(asset["id"])
    news, news_errors = _news(asset)
    recent = [item for item in news if item["t"] >= now - 86400]
    news_warnings = [f"部分新闻源失败：{news_errors[0]}"] if news_errors and not news else []
    base = {
        "id": asset["id"],
        "name": asset["name"],
        "symbol": asset["symbol"],
        "pair": asset["pair"],
        "asset_class": asset["asset_class"],
        "ws_symbol": asset.get("ws_symbol"),
        "tv_symbol": asset.get("tv_symbol"),
        "ipo_date": asset.get("ipo_date"),
        "ipo_price": asset.get("ipo_price"),
        "tradable": asset["tradable"],
        "note": asset["note"],
        "digits": asset["digits"],
        "session": _session(asset["asset_class"], now),
        "as_of": datetime.fromtimestamp(now, SH).isoformat(),
        "horizons": [HORIZONS[k] for k in HORIZON_ORDER],
        "events": events,
        "news": news,
        "news_burst": len(recent) >= 4,
        "warnings": [],
        "guide": GUIDE,
        "catalog": PROS_CONS,
    }
    daily_closed = _daily_closed_map(now)
    try:
        analyzed = _analyze(asset, horizon_key, now, daily_closed)
    except DataError as exc:
        base["error"] = str(exc)
        base["score"] = {"ok": False, "reason": str(exc)}
        base["warnings"] = notes + news_warnings
        return base
    base.update(analyzed)
    merged = list(analyzed["warnings"]) + news_warnings
    if len(recent) >= 4:
        merged.append("过去 24 小时相关新闻较密。标题没有计入分数，先读完再决定要不要把技术读数作废。")
    base["warnings"] = list(dict.fromkeys(merged))
    return base
