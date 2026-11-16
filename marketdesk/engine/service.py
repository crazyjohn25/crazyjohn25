"""Build the board and a single-asset readout from public market data."""

from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from .bars import closed_weeks, return_over, split_closed
from .catalog import GUIDE, PROS_CONS
from .datasources import (
    DataError,
    collect_news,
    fetch_earnings,
    fetch_etf_flows,
    fetch_macro_calendar,
    funding_rate,
    kraken_bars,
    yahoo_bars,
    yahoo_private_mark,
)
from .indicators import compute
from .scoring import evaluate
from .universe import ASSETS, BY_ID, MACRO_NEWS

NY = ZoneInfo("America/New_York")
SH = ZoneInfo("Asia/Shanghai")

_CACHE: dict[str, tuple[float, object]] = {}
_LOCK = threading.Lock()


def cached(key: str, ttl: float, loader):
    now = time.time()
    with _LOCK:
        hit = _CACHE.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    value = loader()
    with _LOCK:
        _CACHE[key] = (time.time(), value)
    return value


def clear_cache() -> None:
    _CACHE.clear()


def _load_bars(asset: dict, horizon: str) -> list[dict]:
    mode = asset["modes"][horizon]

    def load():
        if asset["source"] == "yahoo":
            return yahoo_bars(asset["yahoo"], mode["interval"], mode["range"])
        if asset["source"] == "kraken":
            return kraken_bars(asset["kraken"], int(mode["interval"]))
        raise DataError("这个标的没有 K 线源")

    return cached(f"bars:{asset['id']}:{horizon}", 120, load)


def _calendar():
    return cached("calendar", 6 * 3600, fetch_macro_calendar)


def _earnings_map() -> dict[str, dict]:
    def load():
        found = {}
        for asset in ASSETS:
            symbol = asset.get("earnings_symbol")
            if not symbol:
                continue
            try:
                row = fetch_earnings(symbol)
            except (DataError, TimeoutError, OSError):
                row = None
            if row:
                found[asset["id"]] = {**row, "affects": asset.get("earnings_affects") or [asset["id"]]}
        return found

    return cached("earnings", 6 * 3600, load)


def _flows():
    return cached("flows", 15 * 60, fetch_etf_flows)


def _funding(inst: str):
    return cached(f"funding:{inst}", 120, lambda: funding_rate(inst))


def _news(asset: dict):
    queries = list(asset.get("news") or []) + MACRO_NEWS

    def load():
        return collect_news(queries, 14)

    return cached(f"news:{asset['id']}", 180, load)


def _session(asset_class: str, now: float) -> str:
    if asset_class == "private":
        return "未上市"
    if asset_class == "crypto":
        return "连续交易"
    dt = datetime.fromtimestamp(now, NY)
    if dt.weekday() >= 5:
        return "美股休市"
    start = dt.replace(hour=9, minute=30, second=0, microsecond=0)
    end = dt.replace(hour=16, minute=0, second=0, microsecond=0)
    if start.timestamp() <= now <= end.timestamp():
        return "美股交易中"
    return "美股休市"


def _events_for(asset_id: str) -> tuple[list[dict], list[str]]:
    macro, notes = _calendar()
    events = [dict(event) for event in macro]
    for owner, row in _earnings_map().items():
        if asset_id not in row["affects"]:
            continue
        label = "估计财报日" if row["estimate"] else "财报日"
        events.append(
            {
                "t": row["t"],
                "kind": "earnings",
                "impact": "high",
                "title": f"{row['symbol']} {label} {row['date']}（美东当天，钟点不是公布时刻）",
                "scope": "micro",
                "source": "yahoo / nasdaq",
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
        if isinstance(value, float):
            snap[key] = round(value, 4)
        else:
            snap[key] = value
    data["snapshot"] = snap
    return data


def _chart(full: list[dict], decision_t: int | None) -> list[dict]:
    pack = compute(full)
    start = max(0, len(full) - 180)
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
                "bb_up": num(pack["bb_up"][i]),
                "bb_low": num(pack["bb_low"][i]),
                "supertrend": num(pack["supertrend"][i]),
                "st_dir": pack["supertrend_dir"][i],
                "vwap": num(pack["vwap"][i]),
                "rsi": num(pack["rsi"][i]),
                "macd": num(pack["macd"][i]),
                "macd_signal": num(pack["macd_signal"][i]),
                "macd_hist": num(pack["macd_hist"][i]),
                "vol_ma": num(pack["vol_ma"][i]),
                "decision": bar["t"] == decision_t,
            }
        )
    return candles


def _analyze(asset: dict, horizon: str, now: float, daily_closed: dict[str, list[dict]]) -> dict:
    mode = asset["modes"][horizon]
    full = _load_bars(asset, horizon)
    closed, live = split_closed(full, mode["interval_sec"], asset["asset_class"], now)
    if horizon == "swing":
        higher = closed_weeks(_load_bars(asset, "swing"), now)
    else:
        daily_full = full if horizon == "swing" else _load_bars(asset, "swing")
        higher, _live_daily = split_closed(daily_full, 86400, asset["asset_class"], now)
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
            funding = None
    primary, secondary = _rs(asset, daily_closed)
    if asset.get("rs") and primary is None:
        warnings.append("相对强弱缺少基准收益，这一项本次不投票")
    context = {
        "asset_id": asset["id"],
        "asset_class": asset["asset_class"],
        "now": now,
        "interval_sec": mode["interval_sec"],
        "events": events,
        "flows": flows,
        "funding_rate": funding,
        "rs_primary": primary,
        "rs_secondary": secondary,
        "rs_label": (asset.get("rs") or {}).get("label"),
        "higher_name": mode["higher"],
    }
    result = evaluate(closed, higher, context)
    price_bar = live or (closed[-1] if closed else None)
    prev_close = None
    if live is not None and closed:
        prev_close = closed[-1]["c"]
    elif len(closed) >= 2:
        prev_close = closed[-2]["c"]
    change = None
    if price_bar and prev_close:
        change = price_bar["c"] / prev_close - 1
    return {
        "score": _public_score(result),
        "candles": _chart(full, closed[-1]["t"] if closed else None),
        "events": events,
        "flows": flows[-12:] if flows else None,
        "funding_rate": funding,
        "warnings": warnings,
        "price": None if price_bar is None else price_bar["c"],
        "change_pct": change,
        "decision_t": closed[-1]["t"] if closed else None,
        "live_bar": live is not None,
        "horizon_label": mode["label"],
        "higher_label": mode["higher"],
    }


def _daily_closed_map(now: float) -> dict[str, list[dict]]:
    closed = {}
    for asset in ASSETS:
        if not asset["tradable"]:
            continue
        try:
            bars = _load_bars(asset, "swing")
        except DataError:
            continue
        done, _live = split_closed(bars, 86400, asset["asset_class"], now)
        closed[asset["id"]] = done
    return closed


def _cluster(cards: list[dict]) -> dict:
    by_id = {card["id"]: card for card in cards}
    tech = ["nvda", "amd", "sox", "nasdaq"]
    signed = []
    for asset_id in tech:
        card = by_id.get(asset_id) or {}
        score = card.get("action_score")
        if score is None or abs(score) < 20:
            continue
        signed.append((asset_id, score))
    same = len(signed) >= 3 and len({1 if score > 0 else -1 for _, score in signed}) == 1
    text = "英伟达、AMD、半导体指数和纳指是同一团行业与风险偏好。它们的动作分同向时，不要把四张卡片加成四笔独立仓位。"
    if same:
        text += " 这一轮它们的动作分已经同向，按一笔风险来想。"
    btc = by_id.get("btc") or {}
    nasdaq = by_id.get("nasdaq") or {}
    if btc.get("action_score") is not None and nasdaq.get("action_score") is not None:
        if btc["action_score"] * nasdaq["action_score"] > 0 and abs(btc["action_score"]) >= 20 and abs(nasdaq["action_score"]) >= 20:
            text += " 比特币和纳指目前同向，风险偏好的重叠比平时更高。"
    hype = by_id.get("hype") or {}
    if hype.get("action_score") is not None and btc.get("action_score") is not None:
        text += " HYPE 还要单独看它相对比特币的强弱，它不是纳指的替代品。"
    return {"text": text, "same_tech_direction": same}


def _next_title(events: list[dict], now: float) -> str | None:
    future = [event for event in events if event["t"] >= now - 6 * 3600]
    if not future:
        return None
    event = min(future, key=lambda item: item["t"])
    when = datetime.fromtimestamp(event["t"], SH).strftime("%m-%d %H:%M")
    return f"{event['title']} · {when} 上海"


def board(now: float | None = None) -> dict:
    now = time.time() if now is None else now
    daily_closed = _daily_closed_map(now)
    cards = []
    for asset in ASSETS:
        card = {
            "id": asset["id"],
            "name": asset["name"],
            "symbol": asset["symbol"],
            "pair": asset["pair"],
            "tradable": asset["tradable"],
            "asset_class": asset["asset_class"],
        }
        if not asset["tradable"]:
            try:
                mark = cached("spacex-mark", 300, lambda: yahoo_private_mark(asset["yahoo"]))
                card["price"] = mark["price"]
                card["mark_name"] = mark["name"]
            except DataError as exc:
                card["error"] = str(exc)
            card["stance_label"] = "不评分"
            card["session"] = "未上市"
            try:
                card["next_event"] = _next_title(_events_for(asset["id"])[0], now)
            except (DataError, TimeoutError, OSError):
                card["next_event"] = None
            cards.append(card)
            continue
        try:
            analyzed = _analyze(asset, "swing", now, daily_closed)
        except DataError as exc:
            card["error"] = str(exc)
            cards.append(card)
            continue
        score = analyzed["score"]
        card.update(
            {
                "price": analyzed["price"],
                "change_pct": analyzed["change_pct"],
                "session": _session(asset["asset_class"], now),
                "action_score": score.get("action_score"),
                "direction_score": score.get("direction_score"),
                "execution_score": score.get("execution_score"),
                "stance_label": score.get("stance_label") or "无读数",
                "regime_label": score.get("regime_label"),
                "risk_score": score.get("risk_score"),
                "next_event": _next_title(analyzed["events"], now),
                "error": None if score.get("ok") else score.get("reason"),
            }
        )
        cards.append(card)
    return {
        "as_of": datetime.fromtimestamp(now, SH).isoformat(),
        "cards": cards,
        "cluster": _cluster(cards),
    }


def asset_view(asset_id: str, horizon: str = "swing", now: float | None = None) -> dict:
    asset = BY_ID.get(asset_id)
    if asset is None:
        raise KeyError(asset_id)
    if horizon not in ("swing", "intraday"):
        horizon = "swing"
    now = time.time() if now is None else now
    events, notes = _events_for(asset_id)
    news, news_errors = _news(asset)
    recent = [item for item in news if item["t"] >= now - 86400]
    news_warnings = [f"部分新闻源失败：{news_errors[0]}"] if news_errors and not news else []
    base = {
        "id": asset["id"],
        "name": asset["name"],
        "symbol": asset["symbol"],
        "pair": asset["pair"],
        "tradable": asset["tradable"],
        "note": asset["note"],
        "digits": asset["digits"],
        "session": _session(asset["asset_class"], now),
        "as_of": datetime.fromtimestamp(now, SH).isoformat(),
        "events": events,
        "news": news,
        "news_burst": len(recent) >= 4,
        "warnings": [],
        "guide": GUIDE,
        "catalog": PROS_CONS,
    }
    if not asset["tradable"]:
        try:
            mark = cached("spacex-mark", 300, lambda: yahoo_private_mark(asset["yahoo"]))
            base["price"] = mark["price"]
            base["mark"] = mark
        except DataError as exc:
            base["error"] = str(exc)
        base["score"] = {
            "ok": False,
            "reason": "未上市，没有连续成交，不算技术指标，也不给做多或做空分。",
        }
        base["warnings"] = notes + news_warnings
        return base
    if horizon not in asset["modes"]:
        horizon = "swing"
    daily_closed = _daily_closed_map(now)
    try:
        analyzed = _analyze(asset, horizon, now, daily_closed)
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
    base["horizon"] = horizon
    return base


def shanghai(ts: float) -> str:
    return datetime.fromtimestamp(ts, SH).strftime("%Y-%m-%d %H:%M")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
