"""Regime-aware cross-check. Direction and execution are separate on purpose."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from .catalog import PROS_CONS
from .indicators import compute, percentile_rank

SHANGHAI = ZoneInfo("Asia/Shanghai")

REGIME_TREND = 25.0
REGIME_RANGE = 18.0

WEIGHTS = {
    "ema_stack": ("trend", 12),
    "bbi": ("trend", 6),
    "supertrend": ("trend", 10),
    "dmi": ("trend", 8),
    "higher_tf": ("trend", 8),
    "macd": ("momentum", 9),
    "rsi": ("momentum", 7),
    "kdj": ("momentum", 6),
    "cci": ("momentum", 5),
    "trix": ("momentum", 5),
    "stochrsi": ("momentum", 4),
    "obv": ("volume", 7),
    "volume": ("volume", 4),
    "mfi": ("volume", 5),
    "cmf": ("volume", 4),
    "vwap": ("volume", 5),
    "bollinger": ("location", 6),
    "williams": ("location", 3),
    "relative": ("relative", 6),
    "tvmc": ("summary", 8),
    "etf_flow": ("flow", 8),
    "funding": ("flow", 6),
}

REGIME_MULT = {
    "trend": {"trend": 1.25, "momentum": 1.0, "volume": 1.05, "location": 0.45, "relative": 0.9, "summary": 1.0, "flow": 0.85},
    "range": {"trend": 0.55, "momentum": 1.2, "volume": 0.9, "location": 1.25, "relative": 0.7, "summary": 1.0, "flow": 0.8},
    "transition": {"trend": 0.8, "momentum": 0.75, "volume": 0.8, "location": 0.6, "relative": 0.6, "summary": 0.8, "flow": 0.7},
}


def _at(series, index):
    if series is None or index < 0 or index >= len(series):
        return None
    return series[index]


def _sign(value: float, dead: float = 0.0) -> int:
    if value > dead:
        return 1
    if value < -dead:
        return -1
    return 0


def _fmt(value, digits=2):
    if value is None:
        return "—"
    return f"{value:.{digits}f}"


def classify_regime(adx_now, adx_prev) -> str:
    if adx_now is None:
        return "transition"
    if adx_now >= REGIME_TREND:
        return "trend"
    if adx_now <= REGIME_RANGE:
        return "range"
    return "transition"


def _swing_points(values: list[float], kind: str, left: int = 3, right: int = 3) -> list[int]:
    found = []
    for i in range(left, len(values) - right):
        window = values[i - left : i + right + 1]
        if any(v is None for v in window):
            continue
        if kind == "high" and values[i] == max(window) and values[i] > values[i - 1]:
            found.append(i)
        if kind == "low" and values[i] == min(window) and values[i] < values[i - 1]:
            found.append(i)
    return found


def _divergence(price, indicator, kind: str, end: int) -> bool:
    """Bearish: two highs, price higher, indicator lower. Bullish mirrors that on lows."""
    start = max(0, end - 45)
    px = price[start : end + 1]
    ind = indicator[start : end + 1]
    points = _swing_points(px, "high" if kind == "bear" else "low")
    if len(points) < 2:
        return False
    a, b = points[-2], points[-1]
    if b - a < 5 or b < len(px) - 18:
        return False
    if ind[a] is None or ind[b] is None:
        return False
    if kind == "bear":
        return px[b] > px[a] and ind[b] < ind[a]
    return px[b] < px[a] and ind[b] > ind[a]


def _higher_direction(higher_bars: list[dict], name: str) -> tuple[float | None, str]:
    if higher_bars is None or len(higher_bars) < 20:
        return None, f"{name}样本不足，这项不投票"
    pack = compute(higher_bars)
    i = len(higher_bars) - 1
    ema_fast = _at(pack["ema20"], i)
    ema_slow = _at(pack["ema50"], i)
    close = higher_bars[i]["c"]
    st = _at(pack["supertrend_dir"], i)
    if ema_fast is None:
        return None, f"{name}均线尚未形成"
    votes = []
    if ema_slow is not None:
        if close > ema_fast > ema_slow:
            votes.append(1)
        elif close < ema_fast < ema_slow:
            votes.append(-1)
        else:
            votes.append(0)
    else:
        votes.append(1 if close > ema_fast else -1)
    if st in (1, -1):
        votes.append(st)
    score = sum(votes) / len(votes)
    if score > 0.4:
        return 1, f"{name}收盘与均线、Supertrend 同为多头"
    if score < -0.4:
        return -1, f"{name}收盘与均线、Supertrend 同为空头"
    return 0, f"{name}内部不一致，记为中性"


def _event_horizon(events: list[dict], now: float) -> dict:
    upcoming = None
    in_window = False
    earnings_window = False
    near_days = None
    for event in events:
        delta = event["t"] - now
        if -6 * 3600 <= delta <= 48 * 3600 and event.get("impact") == "high":
            in_window = True
            if event.get("kind") == "earnings":
                earnings_window = True
        if delta >= -6 * 3600 and (upcoming is None or event["t"] < upcoming["t"]):
            upcoming = event
    if upcoming is not None:
        near_days = (upcoming["t"] - now) / 86400
    return {
        "in_window": in_window,
        "earnings_window": earnings_window,
        "next": upcoming,
        "days": near_days,
    }


def _risk(pack, bars, index: int, event_window: bool, days_to_event) -> tuple[float, dict]:
    close = bars[index]["c"]
    atr_v = _at(pack["atr"], index)
    ema20 = _at(pack["ema20"], index)
    atr_pct = []
    width = pack["bb_width"]
    for i in range(len(bars)):
        if pack["atr"][i] is None or bars[i]["c"] == 0:
            atr_pct.append(None)
        else:
            atr_pct.append(pack["atr"][i] / bars[i]["c"])
    vol_rank = percentile_rank(atr_pct, index)
    width_rank = percentile_rank(width, index)
    parts = {}
    weights = {}
    if vol_rank is not None:
        parts["波动分位"] = vol_rank
        weights["波动分位"] = 0.28
    if width_rank is not None:
        parts["带宽分位"] = width_rank
        weights["带宽分位"] = 0.18
    if atr_v not in (None, 0) and ema20 is not None:
        parts["偏离"] = min(100.0, abs(close - ema20) / atr_v * 25.0)
        weights["偏离"] = 0.26
    if atr_v not in (None, 0) and index >= 1:
        shock = abs(close - bars[index - 1]["c"]) / atr_v * 40.0
        parts["冲击"] = min(100.0, shock)
        weights["冲击"] = 0.16
    if event_window:
        parts["事件"] = 78.0
    elif days_to_event is not None and 0 <= days_to_event <= 5:
        parts["事件"] = 42.0
    else:
        parts["事件"] = 8.0
    weights["事件"] = 0.12
    total_w = sum(weights.values())
    score = sum(parts[k] * weights[k] for k in parts) / total_w
    return max(0.0, min(100.0, score)), parts


def _flow_signal(flows: list[dict] | None) -> tuple[float | None, str]:
    if not flows or len(flows) < 3:
        return None, "没有足够的 ETF 净流数据"
    recent = flows[-8:]
    last = recent[-1]["total_musd"]
    streak = 0
    sign = _sign(last, 1.0)
    if sign == 0:
        streak = 0
    else:
        for row in reversed(recent):
            if _sign(row["total_musd"], 1.0) == sign:
                streak += 1
            else:
                break
    five = sum(row["total_musd"] for row in recent[-5:])
    reading = f"最近公布日 {last:+.0f} 百万美元，同向连续 {streak} 日，近 5 日合计 {five:+.0f}"
    if streak >= 4 and sign != 0:
        return float(sign), reading
    if five <= -500:
        return -0.5, reading
    if five >= 500:
        return 0.5, reading
    return 0.0, reading


def _funding_signal(rate: float | None) -> tuple[float | None, str]:
    if rate is None:
        return None, "这个标的没有永续资金费率"
    pct = rate * 100.0
    reading = f"当前资金费率 {pct:.4f}% / 期"
    if rate >= 0.0003:
        return -0.5, reading + "，多头拥挤到值得折扣，但不足以单独做空"
    if rate <= -0.0003:
        return 0.5, reading + "，空头拥挤到值得折扣，但不足以单独做多"
    return 0.0, reading + "，未到极端，不改变方向"


def _relative_signal(primary: float | None, secondary: float | None, label: str) -> tuple[float | None, str]:
    if primary is None and secondary is None:
        return None, "没有基准可比较"
    bits = []
    votes = []
    if primary is not None:
        bits.append(f"相对主基准 {primary * 100:+.1f}%")
        if abs(primary) >= 0.02:
            votes.append(_sign(primary))
        else:
            votes.append(0)
    if secondary is not None:
        bits.append(f"相对次基准 {secondary * 100:+.1f}%")
        if abs(secondary) >= 0.02:
            votes.append(_sign(secondary))
        else:
            votes.append(0)
    if not votes:
        return None, label
    if all(v == 1 for v in votes):
        return 1, label + "，" + "，".join(bits)
    if all(v == -1 for v in votes):
        return -1, label + "，" + "，".join(bits)
    return 0, label + "，" + "，".join(bits) + "，基准之间不一致"


def build_signals(bars, pack, higher_bars, context) -> tuple[list[dict], str, dict]:
    i = len(bars) - 1
    close = bars[i]["c"]
    prev = max(0, i - 1)
    regime = classify_regime(_at(pack["adx"], i), _at(pack["adx"], prev))
    signals = []

    def add(sid, direction, reading):
        group, weight = WEIGHTS[sid]
        meta = PROS_CONS[sid]
        signals.append(
            {
                "id": sid,
                "name": meta["name"],
                "group": group,
                "weight": weight,
                "direction": direction,
                "reading": reading,
                "pros": meta["pros"],
                "cons": meta["cons"],
            }
        )

    ema20, ema50, ema200 = _at(pack["ema20"], i), _at(pack["ema50"], i), _at(pack["ema200"], i)
    if ema20 is None or ema50 is None:
        add("ema_stack", None, "均线样本不足")
    elif ema200 is not None and ema20 > ema50 > ema200 and close > ema20:
        add("ema_stack", 1, f"20>50>200，收盘在 EMA20 {_fmt(ema20)} 之上")
    elif ema200 is not None and ema20 < ema50 < ema200 and close < ema20:
        add("ema_stack", -1, f"20<50<200，收盘在 EMA20 {_fmt(ema20)} 之下")
    elif close > ema20 > ema50:
        add("ema_stack", 0.5, "短中期多头，EMA200 尚未同向")
    elif close < ema20 < ema50:
        add("ema_stack", -0.5, "短中期空头，EMA200 尚未同向")
    else:
        add("ema_stack", 0, "均线缠绕，没有排列")

    bbi_v = _at(pack["bbi"], i)
    if bbi_v is None:
        add("bbi", None, "BBI 样本不足")
    elif close > bbi_v:
        add("bbi", 1, f"收盘在 BBI {_fmt(bbi_v)} 之上")
    elif close < bbi_v:
        add("bbi", -1, f"收盘在 BBI {_fmt(bbi_v)} 之下")
    else:
        add("bbi", 0, "收盘贴着 BBI")

    st_dir = _at(pack["supertrend_dir"], i)
    st_line = _at(pack["supertrend"], i)
    if st_dir not in (1, -1):
        add("supertrend", None, "Supertrend 样本不足")
    else:
        side = "多头" if st_dir == 1 else "空头"
        add("supertrend", float(st_dir), f"Supertrend 为{side}，线在 {_fmt(st_line)}")

    adx = _at(pack["adx"], i)
    plus_di, minus_di = _at(pack["plus_di"], i), _at(pack["minus_di"], i)
    if adx is None or plus_di is None:
        add("dmi", None, "ADX 样本不足")
    elif adx < REGIME_RANGE:
        add("dmi", 0, f"ADX {_fmt(adx, 1)}，低于 18，方向线不投票")
    elif plus_di > minus_di:
        add("dmi", 1, f"ADX {_fmt(adx, 1)}，+DI {_fmt(plus_di, 1)} 高于 -DI {_fmt(minus_di, 1)}")
    else:
        add("dmi", -1, f"ADX {_fmt(adx, 1)}，-DI {_fmt(minus_di, 1)} 高于 +DI {_fmt(plus_di, 1)}")

    higher_dir, higher_text = _higher_direction(higher_bars, context.get("higher_name") or "高周期")
    add("higher_tf", higher_dir, higher_text)

    hist = _at(pack["macd_hist"], i)
    hist_prev = _at(pack["macd_hist"], prev)
    macd_v, macd_s = _at(pack["macd"], i), _at(pack["macd_signal"], i)
    if hist is None or macd_v is None or macd_s is None:
        add("macd", None, "MACD 样本不足")
    elif macd_v > macd_s and hist > 0 and hist_prev is not None and hist >= hist_prev:
        add("macd", 1, f"MACD 在信号线上，柱 {_fmt(hist, 3)} 未缩短")
    elif macd_v < macd_s and hist < 0 and hist_prev is not None and hist <= hist_prev:
        add("macd", -1, f"MACD 在信号线下，柱 {_fmt(hist, 3)} 继续向下")
    elif macd_v > macd_s:
        add("macd", 0, f"仍在信号线上，但柱已缩短到 {_fmt(hist, 3)}")
    elif macd_v < macd_s:
        add("macd", 0, f"仍在信号线下，但空头柱已缩短到 {_fmt(hist, 3)}")
    else:
        add("macd", 0, "MACD 与信号线粘合")

    rsi_v = _at(pack["rsi"], i)
    rsi_prev = _at(pack["rsi"], prev)
    if rsi_v is None:
        add("rsi", None, "RSI 样本不足")
    elif regime == "range":
        if rsi_v < 30:
            add("rsi", 1, f"震荡框架，RSI {_fmt(rsi_v, 1)} 进入超卖区")
        elif rsi_v > 70:
            add("rsi", -1, f"震荡框架，RSI {_fmt(rsi_v, 1)} 进入超买区")
        else:
            add("rsi", 0, f"震荡框架，RSI {_fmt(rsi_v, 1)} 在中性区")
    elif regime == "trend":
        if rsi_v >= 75 or rsi_v <= 25:
            add("rsi", 0, f"趋势框架，RSI {_fmt(rsi_v, 1)} 极端，只记位置风险，不反向")
        elif rsi_prev is not None and rsi_v >= 50 and rsi_v >= rsi_prev:
            add("rsi", 1, f"趋势框架，RSI {_fmt(rsi_v, 1)} 站在 50 上")
        elif rsi_prev is not None and rsi_v < 45 and rsi_v <= rsi_prev:
            add("rsi", -1, f"趋势框架，RSI {_fmt(rsi_v, 1)} 掉到 45 下并走弱")
        else:
            add("rsi", 0, f"趋势框架，RSI {_fmt(rsi_v, 1)} 没有给出同向确认")
    else:
        if rsi_prev is not None and rsi_prev < 50 <= rsi_v:
            add("rsi", 1, f"过渡框架，RSI 上穿 50，现为 {_fmt(rsi_v, 1)}")
        elif rsi_prev is not None and rsi_prev > 50 >= rsi_v:
            add("rsi", -1, f"过渡框架，RSI 下穿 50，现为 {_fmt(rsi_v, 1)}")
        else:
            add("rsi", 0, f"过渡框架，RSI {_fmt(rsi_v, 1)} 不作为方向")

    k, d, j = _at(pack["k"], i), _at(pack["d"], i), _at(pack["j"], i)
    if k is None or d is None:
        add("kdj", None, "KDJ 样本不足")
    elif regime == "range":
        if j is not None and (j < 0 or k < 20) and k >= d:
            add("kdj", 1, f"震荡框架，K {_fmt(k, 1)} D {_fmt(d, 1)} J {_fmt(j, 1)} 在低位转上")
        elif j is not None and (j > 100 or k > 80) and k <= d:
            add("kdj", -1, f"震荡框架，K {_fmt(k, 1)} D {_fmt(d, 1)} J {_fmt(j, 1)} 在高位转下")
        else:
            add("kdj", 0, f"震荡框架，KDJ 未到边缘，K {_fmt(k, 1)}")
    elif k > d and k > 50:
        add("kdj", 1 if regime != "trend" else 0.5, f"K {_fmt(k, 1)} 在 D 之上且高于 50")
    elif k < d and k < 50:
        add("kdj", -1 if regime != "trend" else -0.5, f"K {_fmt(k, 1)} 在 D 之下且低于 50")
    else:
        add("kdj", 0, f"K {_fmt(k, 1)} D {_fmt(d, 1)} 没有干净交叉")

    cci_v = _at(pack["cci"], i)
    if cci_v is None:
        add("cci", None, "CCI 样本不足")
    elif regime == "range":
        if cci_v < -100:
            add("cci", 1, f"震荡框架，CCI {_fmt(cci_v, 0)} 低于 -100")
        elif cci_v > 100:
            add("cci", -1, f"震荡框架，CCI {_fmt(cci_v, 0)} 高于 100")
        else:
            add("cci", 0, f"震荡框架，CCI {_fmt(cci_v, 0)} 在常态内")
    elif abs(cci_v) > 200:
        add("cci", 0, f"CCI {_fmt(cci_v, 0)} 极端，只说明延伸，不反向")
    elif cci_v > 0:
        add("cci", 1, f"CCI {_fmt(cci_v, 0)} 在零轴上")
    else:
        add("cci", -1, f"CCI {_fmt(cci_v, 0)} 在零轴下")

    trix_v, trix_s = _at(pack["trix"], i), _at(pack["trix_signal"], i)
    trix_prev = _at(pack["trix"], prev)
    if trix_v is None or trix_s is None:
        add("trix", None, "TRIX 样本不足")
    elif trix_v > trix_s and (trix_prev is None or trix_v >= trix_prev):
        add("trix", 1, f"TRIX {_fmt(trix_v, 3)} 在信号线之上")
    elif trix_v < trix_s and (trix_prev is None or trix_v <= trix_prev):
        add("trix", -1, f"TRIX {_fmt(trix_v, 3)} 在信号线之下")
    else:
        add("trix", 0, f"TRIX {_fmt(trix_v, 3)} 与信号线方向不一致")

    sk, sd = _at(pack["stoch_k"], i), _at(pack["stoch_d"], i)
    if sk is None or sd is None:
        add("stochrsi", None, "StochRSI 样本不足")
    elif regime == "range" and sk < 20 and sk >= sd:
        add("stochrsi", 1, f"震荡框架，StochRSI K {_fmt(sk, 1)} 低位转上")
    elif regime == "range" and sk > 80 and sk <= sd:
        add("stochrsi", -1, f"震荡框架，StochRSI K {_fmt(sk, 1)} 高位转下")
    elif regime == "trend" and sk > sd and sk > 50:
        add("stochrsi", 0.5, f"趋势框架，StochRSI K {_fmt(sk, 1)} 在 50 上")
    elif regime == "trend" and sk < sd and sk < 50:
        add("stochrsi", -0.5, f"趋势框架，StochRSI K {_fmt(sk, 1)} 在 50 下")
    else:
        add("stochrsi", 0, f"StochRSI K {_fmt(sk, 1)} 不额外投票")

    obv_now = _at(pack["obv"], i)
    obv_then = _at(pack["obv"], max(0, i - 10))
    price_slope = close - bars[max(0, i - 10)]["c"]
    if obv_now is None or obv_then is None:
        add("obv", None, "OBV 样本不足")
    else:
        obv_slope = obv_now - obv_then
        if price_slope > 0 and obv_slope > 0:
            add("obv", 1, "近 10 根价格与 OBV 同时向上")
        elif price_slope < 0 and obv_slope < 0:
            add("obv", -1, "近 10 根价格与 OBV 同时向下")
        elif price_slope > 0 and obv_slope < 0:
            add("obv", 0, "价格上涨但 OBV 下降，量能不确认")
        elif price_slope < 0 and obv_slope > 0:
            add("obv", 0, "价格下跌但 OBV 上升，抛压没有同步")
        else:
            add("obv", 0, "价格或 OBV 近 10 根几乎走平")

    vol = bars[i]["v"] or 0.0
    vol_ma = _at(pack["vol_ma"], i)
    candle_up = close >= bars[i]["o"]
    if vol_ma in (None, 0):
        add("volume", None, "成交量均线不足")
    else:
        ratio = vol / vol_ma
        if ratio >= 1.15 and ((candle_up and price_slope >= 0) or (not candle_up and price_slope < 0)):
            direction = 1 if candle_up else -1
            add("volume", direction, f"成交量是 20 均量的 {ratio:.2f} 倍，并与 K 线方向一致")
        elif ratio < 0.75:
            add("volume", 0, f"成交量只有 20 均量的 {ratio:.2f} 倍，不确认突破")
        else:
            add("volume", 0, f"成交量是 20 均量的 {ratio:.2f} 倍，中性")

    mfi_v = _at(pack["mfi"], i)
    if mfi_v is None:
        add("mfi", None, "MFI 样本不足")
    elif regime == "range" and mfi_v < 20:
        add("mfi", 1, f"震荡框架，MFI {_fmt(mfi_v, 1)} 超卖")
    elif regime == "range" and mfi_v > 80:
        add("mfi", -1, f"震荡框架，MFI {_fmt(mfi_v, 1)} 超买")
    elif regime != "range" and mfi_v > 85:
        add("mfi", 0, f"MFI {_fmt(mfi_v, 1)} 极端，趋势里不反向")
    elif mfi_v > 55:
        add("mfi", 1 if regime != "range" else 0, f"MFI {_fmt(mfi_v, 1)} 在 55 之上")
    elif mfi_v < 45:
        add("mfi", -1 if regime != "range" else 0, f"MFI {_fmt(mfi_v, 1)} 在 45 之下")
    else:
        add("mfi", 0, f"MFI {_fmt(mfi_v, 1)} 在中轴附近")

    cmf_v = _at(pack["cmf"], i)
    if cmf_v is None:
        add("cmf", None, "CMF 样本不足")
    elif cmf_v > 0.05:
        add("cmf", 1, f"CMF {_fmt(cmf_v, 3)}，收盘偏向高位")
    elif cmf_v < -0.05:
        add("cmf", -1, f"CMF {_fmt(cmf_v, 3)}，收盘偏向低位")
    else:
        add("cmf", 0, f"CMF {_fmt(cmf_v, 3)}，没有明显偏向")

    vwap = _at(pack["vwap"], i)
    if vwap is None:
        add("vwap", None, "VWAP 样本不足")
    elif close > vwap:
        note = "日线使用 20 根滚动 VWAP，不是分时 VWAP" if context.get("interval_sec", 86400) >= 86400 else "收盘在窗口 VWAP 之上"
        add("vwap", 1, f"{note}，VWAP {_fmt(vwap)}")
    else:
        note = "日线使用 20 根滚动 VWAP，不是分时 VWAP" if context.get("interval_sec", 86400) >= 86400 else "收盘在窗口 VWAP 之下"
        add("vwap", -1, f"{note}，VWAP {_fmt(vwap)}")

    percent_b = _at(pack["percent_b"], i)
    if percent_b is None:
        add("bollinger", None, "布林带样本不足")
    elif regime == "range" and percent_b <= 0.08:
        add("bollinger", 1, f"震荡框架，%B {_fmt(percent_b, 2)} 贴下轨")
    elif regime == "range" and percent_b >= 0.92:
        add("bollinger", -1, f"震荡框架，%B {_fmt(percent_b, 2)} 贴上轨")
    elif regime == "trend" and percent_b >= 1:
        add("bollinger", 0, f"%B {_fmt(percent_b, 2)} 收在上轨外，趋势里这不是做空")
    elif close > (_at(pack["bb_mid"], i) or close):
        add("bollinger", 0.5 if regime == "trend" else 0, f"%B {_fmt(percent_b, 2)}，在中轨之上")
    elif close < (_at(pack["bb_mid"], i) or close):
        add("bollinger", -0.5 if regime == "trend" else 0, f"%B {_fmt(percent_b, 2)}，在中轨之下")
    else:
        add("bollinger", 0, f"%B {_fmt(percent_b, 2)}")

    will = _at(pack["williams"], i)
    if will is None:
        add("williams", None, "Williams %R 样本不足")
    elif regime != "range":
        add("williams", 0, f"%R {_fmt(will, 1)}。趋势或过渡里这条会钝化，方向分记 0")
    elif will <= -80:
        add("williams", 1, f"震荡框架，%R {_fmt(will, 1)} 进入超卖")
    elif will >= -20:
        add("williams", -1, f"震荡框架，%R {_fmt(will, 1)} 进入超买")
    else:
        add("williams", 0, f"%R {_fmt(will, 1)} 在中性区")

    rel_dir, rel_text = _relative_signal(
        context.get("rs_primary"),
        context.get("rs_secondary"),
        context.get("rs_label") or "相对强弱",
    )
    add("relative", rel_dir, rel_text)

    if context.get("asset_id") == "btc":
        flow_dir, flow_text = _flow_signal(context.get("flows"))
        add("etf_flow", flow_dir, flow_text)
    if context.get("asset_class") == "crypto":
        fund_dir, fund_text = _funding_signal(context.get("funding_rate"))
        add("funding", fund_dir, fund_text)

    return signals, regime, {"percent_b": percent_b, "higher": higher_dir}


def _leg(signals, group: str) -> float | None:
    vals = [s["direction"] for s in signals if s["group"] == group and s["direction"] is not None]
    if not vals:
        return None
    return sum(vals) / len(vals)


def _tvmc(signals) -> tuple[float, float]:
    trend, mom, vol = _leg(signals, "trend"), _leg(signals, "momentum"), _leg(signals, "volume")
    parts = [p for p in (trend, mom, vol) if p is not None]
    if len(parts) < 3:
        return 0.0, 0.0
    value = 100.0 * (0.45 * trend + 0.35 * mom + 0.20 * vol)
    value = max(-100.0, min(100.0, value))
    signs = [_sign(trend, 0.2), _sign(mom, 0.2), _sign(vol, 0.2)]
    if signs[0] != 0 and signs[0] == signs[1] == signs[2]:
        return float(signs[0]), value
    return 0.0, value


def _stance(action: float, regime: str) -> tuple[str, str]:
    if regime == "range":
        if action >= 55:
            return "range_long", "震荡低吸"
        if action >= 28:
            return "range_long_light", "震荡轻度低吸"
        if action <= -55:
            return "range_short", "震荡高抛"
        if action <= -28:
            return "range_short_light", "震荡轻度高抛"
        return "flat", "观望"
    prefix = "趋势" if regime == "trend" else "过渡"
    if action >= 60:
        return f"{regime}_long", f"{prefix}偏多"
    if action >= 28:
        return f"{regime}_long_light", f"{prefix}轻度偏多"
    if action <= -60:
        return f"{regime}_short", f"{prefix}偏空"
    if action <= -28:
        return f"{regime}_short_light", f"{prefix}轻度偏空"
    return "flat", "观望"


def _execution(bars, pack, index: int, regime: str, direction_score: float, context_flags: dict) -> tuple[float, list[str]]:
    notes = []
    score = 62.0
    close = bars[index]["c"]
    atr_v = _at(pack["atr"], index)
    ema20 = _at(pack["ema20"], index)
    percent_b = _at(pack["percent_b"], index)
    if atr_v not in (None, 0) and ema20 is not None:
        stretch = abs(close - ema20) / atr_v
        aligned = (direction_score > 0 and close >= ema20) or (direction_score < 0 and close <= ema20)
        if regime == "trend" and aligned and stretch <= 0.7:
            score += 16
            notes.append("价格靠近 EMA20，趋势方向上这是回踩而不是追价")
        elif stretch <= 1.4:
            score += 4
        elif stretch <= 2.4:
            score -= 14
            notes.append(f"价格离开 EMA20 已有 {stretch:.1f} 倍 ATR")
        else:
            score -= 28
            notes.append(f"价格离开 EMA20 达 {stretch:.1f} 倍 ATR，不适合追")
    if regime == "range" and percent_b is not None:
        if percent_b <= 0.12 or percent_b >= 0.88:
            if (direction_score > 0 and percent_b <= 0.12) or (direction_score < 0 and percent_b >= 0.88):
                score += 14
                notes.append("震荡框架里，价格正在区间边缘，和方向一致")
        else:
            score -= 10
            notes.append("价格在区间中部，震荡策略没有位置优势")
    vol_ma = _at(pack["vol_ma"], index)
    if vol_ma not in (None, 0):
        ratio = (bars[index]["v"] or 0) / vol_ma
        if ratio >= 1.15:
            score += 6
        elif ratio < 0.7:
            score -= 6
            notes.append("成交量偏弱，突破质量不足")
    if context_flags.get("risk", 0) >= 75:
        score -= 10
        notes.append("SCTI-RSK 高于 75，执行分下调")
    return max(0.0, min(100.0, score)), notes


def invalidation(bars, pack, index: int, action: float) -> dict:
    close = bars[index]["c"]
    atr_v = _at(pack["atr"], index) or 0.0
    st = _at(pack["supertrend"], index)
    ema20 = _at(pack["ema20"], index)
    if action >= 0:
        below = [level for level in (st, ema20) if level is not None and level < close]
        level = max(below) if below else close - 1.5 * atr_v
        side = "多头"
    else:
        above = [level for level in (st, ema20) if level is not None and level > close]
        level = min(above) if above else close + 1.5 * atr_v
        side = "空头"
    distance = abs(close - level) / atr_v if atr_v else None
    return {
        "level": level,
        "side": side,
        "atr": atr_v,
        "distance_atr": distance,
        "text": f"若之后收盘穿越 {_fmt(level)}，这次{side}读数作废。这是结构失效位，不是已经挂进交易所的止损单。",
    }


def _build_playbook(bars, pack, index: int, regime: str, direction: float, exec_score: float, action: float, risk_score: float, inv: dict, events: dict, positives: list, negatives: list, adjustments: list) -> dict:
    close = bars[index]["c"]
    atr_v = _at(pack["atr"], index) or close * 0.02
    ema20 = _at(pack["ema20"], index) or close
    bb_up = _at(pack["bb_up"], index) or (close + 2 * atr_v)
    bb_low = _at(pack["bb_low"], index) or (close - 2 * atr_v)
    recent = bars[max(0, index - 20) : index + 1]
    swing_high = max(b["h"] for b in recent)
    swing_low = min(b["l"] for b in recent)
    stretch = abs(close - ema20) / atr_v if atr_v else 0.0

    if direction >= 18:
        bias = "long"
        zone_title = "支撑低吸参考区" if regime == "range" else "顺势回踩介入区"
        if regime == "range":
            zone_low = min(bb_low, swing_low)
            zone_high = zone_low + 0.45 * atr_v
        else:
            anchor = max(inv["level"] + 0.15 * atr_v, ema20 - 0.35 * atr_v)
            zone_low = min(close, anchor)
            zone_high = min(close * 1.003, max(anchor + 0.45 * atr_v, ema20 + 0.2 * atr_v))
        target1 = max(close + 1.4 * atr_v, swing_high, bb_up)
        target2 = max(target1 + 1.2 * atr_v, close + 2.8 * atr_v)
    elif direction <= -18:
        bias = "short"
        zone_title = "反弹减仓 / 压力观察区"
        cap = inv["level"] - 0.15 * atr_v
        anchor = min(cap, ema20 + 0.3 * atr_v)
        zone_low = max(close * 0.997, min(ema20 - 0.25 * atr_v, anchor - 0.4 * atr_v))
        zone_high = max(zone_low + 0.25 * atr_v, anchor)
        target1 = min(close - 1.4 * atr_v, swing_low, bb_low)
        target2 = min(target1 - 1.2 * atr_v, close - 2.8 * atr_v)
    else:
        bias = "neutral"
        zone_title = "震荡区间下沿支撑 / 上沿阻力"
        zone_low = min(bb_low, swing_low)
        zone_high = max(bb_up, swing_high)
        target1 = zone_high
        target2 = min(bb_low, swing_low)

    risk_dist = max(abs(close - inv["level"]), 0.85 * atr_v)
    rr_now = round(min(6.0, abs(target1 - close) / risk_dist), 2)
    entry_mid = (zone_low + zone_high) / 2.0
    rr_pullback = round(min(6.0, abs(target1 - entry_mid) / max(abs(entry_mid - inv["level"]), 0.85 * atr_v)), 2)

    if events["earnings_window"]:
        verdict_title, verdict_tone = "财报跳空高危窗口 · 严控仓位观望", "flat"
        spot_action = "距离财报极近，盘前盘后易现跳空缺口。忠实建议：不要在财报前重仓赌方向，浮盈仓位可适当锁利。"
        swing_action = "暂停新建高倍杠杆或短线追单，等待财报落地确认方向后再顺势跟随。"
        position_cap = "10%–15% 以内（财报避险上限）"
    elif events["in_window"]:
        verdict_title, verdict_tone = "重大宏观数据窗口 · 降仓避险", "flat"
        spot_action = "未来 48 小时内有美联储利率决议 / CPI / 非农等核心宏观数据，建议暂停追单，保留现金等待落地。"
        swing_action = "主动收缩杠杆敞口，避免数据公布前重仓扛单。"
        position_cap = "15%–20% 以内（宏观窗口上限）"
    elif action >= 55:
        verdict_title, verdict_tone = "多头强力共振 · 顺势偏多布局", "up"
        spot_action = f"趋势、动量与量能多头同向（综合总分 +{action:.0f}），可分批建仓或顺势持仓，收盘不破 {_fmt(inv['level'])} 持有。"
        swing_action = f"回踩 {_fmt(zone_low)}–{_fmt(zone_high)} 可顺势做多，破 {_fmt(inv['level'])} 止损。"
        position_cap = "35%–45%" if risk_score >= 68 else "50%–65%（标准顺势仓）"
    elif action >= 25:
        verdict_title, verdict_tone = "温和偏多 · 逢低分批，切勿追高", "up"
        spot_action = f"大方向看涨（方向分 +{direction:.0f}），宜在 {_fmt(zone_low)}–{_fmt(zone_high)} 分批低吸，勿急拉满仓。"
        swing_action = f"等回踩支撑企稳介入，破 {_fmt(inv['level'])} 止损。"
        position_cap = "25%–40%（分 2 批介入）"
    elif action <= -55:
        verdict_title, verdict_tone = "空头趋势确立 · 严格规避抄底", "down"
        spot_action = f"核心指标共振看跌（综合总分 {action:.0f}），严禁左侧抄底接飞刀，持仓逢反抽减仓。"
        swing_action = f"反抽 {_fmt(zone_low)}–{_fmt(zone_high)} 受阻偏空，收盘站上 {_fmt(inv['level'])} 止损。"
        position_cap = "现货 0%–10% 防守；空单上限 30%–40%"
    elif action <= -25:
        verdict_title, verdict_tone = "偏空承压 · 减仓防守，不急抄底", "down"
        spot_action = f"空头力量占优（综合总分 {action:.0f}），建议反弹减仓防守，等待收复 {_fmt(inv['level'])} 后再看多。"
        swing_action = f"勿在急跌地板价追空，观察反抽 {_fmt(zone_low)}–{_fmt(zone_high)} 承压情况。"
        position_cap = "现货防守观望；波段轻仓 15%–25%"
    else:
        verdict_title, verdict_tone = "多空分歧拉锯 · 现金观望最有利", "flat"
        spot_action = f"多空指标抵消或短线偏离均线过大（综合总分 {action:+.0f}），不交易即是最佳仓位保护。"
        swing_action = f"关注 {_fmt(zone_low)}–{_fmt(zone_high)} 关键区间，突破确认前不重仓单边。"
        position_cap = "0%–15%（保留现金耐心等待）"

    pct = ((inv["level"] - close) / close * 100.0) if close else None
    return {
        "bias": bias,
        "verdict_title": verdict_title,
        "verdict_tone": verdict_tone,
        "spot_action": spot_action,
        "swing_action": swing_action,
        "position_cap": position_cap,
        "zone_title": zone_title,
        "entry_low": round(zone_low, 4),
        "entry_high": round(zone_high, 4),
        "stop_level": round(inv["level"], 4),
        "stop_pct": None if pct is None else round(pct, 2),
        "target_1": round(target1, 4),
        "target_2": round(target2, 4),
        "rr_now": rr_now,
        "rr_pullback": rr_pullback,
        "swing_high_20": round(swing_high, 4),
        "swing_low_20": round(swing_low, 4),
        "stretch_atr": round(stretch, 2),
        "bull_points": [{"name": s["name"], "points": round(s["points"], 1), "text": s["reading"]} for s in positives[:4]],
        "bear_points": [{"name": s["name"], "points": round(s["points"], 1), "text": s["reading"]} for s in negatives[:3]],
    }


def evaluate(bars: list[dict], higher_bars: list[dict] | None, context: dict) -> dict:
    if len(bars) < 80:
        return {
            "ok": False,
            "reason": "已收盘 K 线少于 80 根，EMA 与背离都不可靠，这次不给方向分。",
        }
    pack = compute(bars)
    i = len(bars) - 1
    now = context.get("now", bars[i]["t"])
    events = _event_horizon(context.get("events") or [], now)
    signals, regime, extra = build_signals(bars, pack, higher_bars, context)
    tvmc_dir, tvmc_value = _tvmc(signals)
    trend_leg, mom_leg, vol_leg = _leg(signals, "trend"), _leg(signals, "momentum"), _leg(signals, "volume")
    tvmc_reading = (
        f"趋势组 {_fmt(None if trend_leg is None else trend_leg * 100, 0)}，"
        f"动量组 {_fmt(None if mom_leg is None else mom_leg * 100, 0)}，"
        f"量能组 {_fmt(None if vol_leg is None else vol_leg * 100, 0)}，"
        f"TVMC {tvmc_value:.0f}"
    )
    if tvmc_dir == 0:
        tvmc_reading += "。三组没有同向，不加摘要分"
    else:
        tvmc_reading += "。三组同向，摘要分按这个方向计入"
    from .catalog import PROS_CONS

    signals.append(
        {
            "id": "tvmc",
            "name": PROS_CONS["tvmc"]["name"],
            "group": "summary",
            "weight": WEIGHTS["tvmc"][1],
            "direction": tvmc_dir,
            "reading": tvmc_reading,
            "pros": PROS_CONS["tvmc"]["pros"],
            "cons": PROS_CONS["tvmc"]["cons"],
        }
    )

    risk, risk_parts = _risk(pack, bars, i, events["in_window"], events["days"])
    mults = REGIME_MULT[regime]
    weighted = []
    available = 0.0
    raw = 0.0
    for signal in signals:
        group_mult = mults.get(signal["group"], 1.0)
        effective = signal["weight"] * group_mult
        signal["effective_weight"] = effective
        if signal["direction"] is None:
            signal["points"] = None
            continue
        available += effective
        contribution = signal["direction"] * effective
        raw += contribution
        weighted.append(signal)
    direction = 0.0 if available == 0 else 100.0 * raw / available
    adjustments = []

    def group_sum(group: str) -> float:
        return sum(
            (s["direction"] or 0) * s["effective_weight"]
            for s in signals
            if s["group"] == group and s["direction"] is not None
        )

    trend_sum, mom_sum = group_sum("trend"), group_sum("momentum")
    if trend_sum * mom_sum < 0 and abs(trend_sum) > 4 and abs(mom_sum) > 4:
        direction *= 0.7
        adjustments.append({"name": "趋势与动量冲突", "effect": "方向分 ×0.70", "text": "趋势组和动量组方向相反，先视为没有干净的交易，而不是选边。"})

    close_series = [b["c"] for b in bars]
    div_hits = []
    if _divergence(close_series, pack["rsi"], "bear", i):
        div_hits.append(("RSI 顶背离", "bear"))
    if _divergence(close_series, pack["rsi"], "bull", i):
        div_hits.append(("RSI 底背离", "bull"))
    if _divergence(close_series, pack["macd_hist"], "bear", i):
        div_hits.append(("MACD 柱顶背离", "bear"))
    if _divergence(close_series, pack["macd_hist"], "bull", i):
        div_hits.append(("MACD 柱底背离", "bull"))
    if _divergence(close_series, pack["obv"], "bear", i):
        div_hits.append(("OBV 顶背离", "bear"))
    if _divergence(close_series, pack["obv"], "bull", i):
        div_hits.append(("OBV 底背离", "bull"))
    for name, kind in div_hits:
        against = (kind == "bear" and direction > 0) or (kind == "bull" and direction < 0)
        if against:
            direction *= 0.86
            adjustments.append({"name": name, "effect": "方向分 ×0.86", "text": f"出现{name}，并且它和当前方向相反。背离只打折，不单独翻向。"})
        else:
            adjustments.append({"name": name, "effect": "只记录", "text": f"出现{name}，但当前净方向并不靠它开仓。"})

    higher = extra["higher"]
    if higher in (1, -1) and _sign(direction, 8) not in (0, higher):
        direction *= 0.75
        adjustments.append({"name": "高周期冲突", "effect": "方向分 ×0.75", "text": "决策周期和高周期方向相反。低周期的优势经常被高周期吃掉。"})

    damp = 1.0 - 0.30 * max(0.0, (risk - 55.0) / 45.0)
    if damp < 0.999:
        direction *= damp
        adjustments.append({"name": "SCTI-RSK", "effect": f"方向分 ×{damp:.2f}", "text": f"风险读数 {risk:.0f}。高波动和事件只降低信心，不自动翻成反向单。"})

    direction = max(-100.0, min(100.0, direction))
    intended = sum(WEIGHTS[s][1] for s in WEIGHTS)
    # Coverage uses base weights of signals we could compute, including neutrals.
    present_weight = sum(s["weight"] for s in signals if s["direction"] is not None)
    possible = sum(s["weight"] for s in signals)
    coverage = 1.0 if possible == 0 else present_weight / possible

    exec_score, exec_notes = _execution(
        bars, pack, i, regime, direction, {"risk": risk}
    )
    if events["earnings_window"]:
        exec_score = min(exec_score, 34)
        adjustments.append({"name": "财报窗口", "effect": "执行分封顶 34", "text": "财报前后，技术结构解释不了跳空。这段时间不把分数当成加仓理由。"})
    elif events["in_window"]:
        exec_score = min(exec_score, 40)
        adjustments.append({"name": "宏观窗口", "effect": "执行分封顶 40", "text": "CPI、非农或 FOMC 临近。事件本身比这一组指标更可能主导下一根 K 线。"})
    if coverage < 0.75:
        exec_score = min(exec_score, 58)
        adjustments.append({"name": "数据缺口", "effect": "执行分封顶 58", "text": "有指标算不出来。方向分已按可得指标归一，但信心应当下降。"})

    action = direction * (exec_score / 100.0)
    code, label = _stance(action, regime)
    level = invalidation(bars, pack, i, action if abs(action) >= 8 else direction)

    for signal in signals:
        if signal["direction"] is None or available == 0:
            signal["points"] = None
        else:
            signal["points"] = 100.0 * signal["direction"] * signal["effective_weight"] / available

    regime_label = {"trend": "趋势", "range": "震荡", "transition": "过渡"}[regime]
    positives = [s for s in signals if (s["points"] or 0) > 1.5]
    negatives = [s for s in signals if (s["points"] or 0) < -1.5]
    positives.sort(key=lambda s: -(s["points"] or 0))
    negatives.sort(key=lambda s: s["points"] or 0)
    bits = [
        f"按{regime_label}框架，读取最后一根已收盘 K 线。",
        f"方向分 {direction:.0f}，执行分 {exec_score:.0f}，动作分 {action:.0f}，结论是「{label}」。",
    ]
    if positives:
        bits.append("多头侧主要来自" + "、".join(s["name"] for s in positives[:3]) + "。")
    if negatives:
        bits.append("空头侧主要来自" + "、".join(s["name"] for s in negatives[:3]) + "。")
    for note in exec_notes[:2]:
        bits.append(note + "。")
    if events["next"] is not None:
        when = datetime.fromtimestamp(events["next"]["t"], SHANGHAI).strftime("%Y-%m-%d %H:%M 上海")
        bits.append(f"下一件高影响日程：{events['next']['title']}（{when}）。")
    bits.append("这是结构读数，不是收益承诺，也不是下单指令。")

    snapshot = {
        "close": bars[i]["c"],
        "t": bars[i]["t"],
        "rsi": _at(pack["rsi"], i),
        "macd": _at(pack["macd"], i),
        "macd_hist": _at(pack["macd_hist"], i),
        "k": _at(pack["k"], i),
        "d": _at(pack["d"], i),
        "j": _at(pack["j"], i),
        "adx": _at(pack["adx"], i),
        "plus_di": _at(pack["plus_di"], i),
        "minus_di": _at(pack["minus_di"], i),
        "cci": _at(pack["cci"], i),
        "trix": _at(pack["trix"], i),
        "bbi": _at(pack["bbi"], i),
        "obv": _at(pack["obv"], i),
        "vwap": _at(pack["vwap"], i),
        "mfi": _at(pack["mfi"], i),
        "cmf": _at(pack["cmf"], i),
        "atr": _at(pack["atr"], i),
        "percent_b": extra["percent_b"],
        "supertrend": _at(pack["supertrend"], i),
        "supertrend_dir": _at(pack["supertrend_dir"], i),
        "ema20": _at(pack["ema20"], i),
        "ema50": _at(pack["ema50"], i),
        "ema200": _at(pack["ema200"], i),
        "williams": _at(pack["williams"], i),
        "stoch_k": _at(pack["stoch_k"], i),
        "tvmc": tvmc_value,
        "aroon_up": _at(pack["aroon_up"], i),
        "aroon_down": _at(pack["aroon_down"], i),
    }
    playbook = _build_playbook(
        bars, pack, i, regime, direction, exec_score, action, risk, level, events, positives, negatives, adjustments
    )
    return {
        "ok": True,
        "regime": regime,
        "regime_label": regime_label,
        "direction_score": round(direction, 1),
        "execution_score": round(exec_score, 1),
        "action_score": round(action, 1),
        "stance": code,
        "stance_label": label,
        "risk_score": round(risk, 1),
        "risk_parts": {k: round(v, 1) for k, v in risk_parts.items()},
        "tvmc": round(tvmc_value, 1),
        "coverage": round(coverage, 2),
        "summary": "".join(bits),
        "playbook": playbook,
        "signals": signals,
        "adjustments": adjustments,
        "invalidation": level,
        "execution_notes": exec_notes,
        "snapshot": snapshot,
        "pack": pack,
        "decision_index": i,
        "next_event": events["next"],
        "event_window": events["in_window"] or events["earnings_window"],
        "intended_weight": intended,
    }
