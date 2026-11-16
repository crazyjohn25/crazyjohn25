"""Standard technical indicators.

Formulas are the ones used by most charting platforms (Wilder smoothing,
population standard deviation for Bollinger, Chinese KDJ with 1/3 RSV).
TradingView's Supertrend flag uses the opposite sign; this module uses
+1 for an uptrend and -1 for a downtrend.
"""

from __future__ import annotations

import math


def _none(n: int) -> list:
    return [None] * n


def sma(values: list[float], period: int) -> list:
    out = _none(len(values))
    if period <= 0 or len(values) < period:
        return out
    total = sum(values[:period])
    out[period - 1] = total / period
    for i in range(period, len(values)):
        total += values[i] - values[i - period]
        out[i] = total / period
    return out


def ema(values: list[float], period: int) -> list:
    out = _none(len(values))
    if len(values) < period or period <= 0:
        return out
    k = 2.0 / (period + 1)
    seed = sum(values[:period]) / period
    out[period - 1] = seed
    prev = seed
    for i in range(period, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def ema_optional(values: list, period: int) -> list:
    out = _none(len(values))
    buf: list[float] = []
    start = None
    for i, value in enumerate(values):
        if value is None:
            continue
        buf.append(value)
        if len(buf) == period:
            seed = sum(buf) / period
            out[i] = seed
            start = i
            break
    if start is None:
        return out
    k = 2.0 / (period + 1)
    prev = out[start]
    for i in range(start + 1, len(values)):
        value = values[i]
        if value is None:
            continue
        prev = value * k + prev * (1 - k)
        out[i] = prev
    return out


def _stdev(window: list[float]) -> float:
    mean = sum(window) / len(window)
    var = sum((x - mean) ** 2 for x in window) / len(window)
    return math.sqrt(var)


def true_ranges(high: list[float], low: list[float], close: list[float]) -> list[float]:
    out = [high[0] - low[0]]
    for i in range(1, len(close)):
        out.append(
            max(
                high[i] - low[i],
                abs(high[i] - close[i - 1]),
                abs(low[i] - close[i - 1]),
            )
        )
    return out


def rma(values: list[float], period: int) -> list:
    out = _none(len(values))
    if len(values) < period or period <= 0:
        return out
    prev = sum(values[:period]) / period
    out[period - 1] = prev
    for i in range(period, len(values)):
        prev = (prev * (period - 1) + values[i]) / period
        out[i] = prev
    return out


def atr(high, low, close, period: int = 14) -> list:
    return rma(true_ranges(high, low, close), period)


def rsi(close: list[float], period: int = 14) -> list:
    out = _none(len(close))
    if len(close) <= period:
        return out
    gain = 0.0
    loss = 0.0
    for i in range(1, period + 1):
        change = close[i] - close[i - 1]
        gain += max(change, 0.0)
        loss += max(-change, 0.0)
    avg_gain = gain / period
    avg_loss = loss / period

    def _rsi(avg_g: float, avg_l: float) -> float:
        if avg_l == 0:
            return 100.0 if avg_g > 0 else 50.0
        rs = avg_g / avg_l
        return 100.0 - 100.0 / (1.0 + rs)

    out[period] = _rsi(avg_gain, avg_loss)
    for i in range(period + 1, len(close)):
        change = close[i] - close[i - 1]
        avg_gain = (avg_gain * (period - 1) + max(change, 0.0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-change, 0.0)) / period
        out[i] = _rsi(avg_gain, avg_loss)
    return out


def macd(close: list[float], fast: int = 12, slow: int = 26, signal_n: int = 9):
    fast_ema = ema(close, fast)
    slow_ema = ema(close, slow)
    line = [
        None if fast_ema[i] is None or slow_ema[i] is None else fast_ema[i] - slow_ema[i]
        for i in range(len(close))
    ]
    signal = ema_optional(line, signal_n)
    hist = [
        None if line[i] is None or signal[i] is None else line[i] - signal[i]
        for i in range(len(close))
    ]
    return line, signal, hist


def kdj(high, low, close, n: int = 9):
    size = len(close)
    k_out, d_out, j_out = _none(size), _none(size), _none(size)
    k = 50.0
    d = 50.0
    for i in range(size):
        if i < n - 1:
            continue
        lowest = min(low[i - n + 1 : i + 1])
        highest = max(high[i - n + 1 : i + 1])
        rsv = 50.0 if highest == lowest else (close[i] - lowest) / (highest - lowest) * 100.0
        k = (2.0 * k + rsv) / 3.0
        d = (2.0 * d + k) / 3.0
        k_out[i] = k
        d_out[i] = d
        j_out[i] = 3.0 * k - 2.0 * d
    return k_out, d_out, j_out


def bollinger(close: list[float], period: int = 20, mult: float = 2.0):
    mid = sma(close, period)
    upper, lower, width, percent_b = _none(len(close)), _none(len(close)), _none(len(close)), _none(len(close))
    for i in range(period - 1, len(close)):
        window = close[i - period + 1 : i + 1]
        sd = _stdev(window)
        middle = mid[i]
        upper[i] = middle + mult * sd
        lower[i] = middle - mult * sd
        if middle:
            width[i] = (upper[i] - lower[i]) / middle
        span = upper[i] - lower[i]
        percent_b[i] = 0.5 if span == 0 else (close[i] - lower[i]) / span
    return mid, upper, lower, width, percent_b


def dmi(high, low, close, period: int = 14):
    size = len(close)
    plus_dm = [0.0] * size
    minus_dm = [0.0] * size
    for i in range(1, size):
        up = high[i] - high[i - 1]
        down = low[i - 1] - low[i]
        plus_dm[i] = up if up > down and up > 0 else 0.0
        minus_dm[i] = down if down > up and down > 0 else 0.0
    tr = true_ranges(high, low, close)
    sm_tr = rma(tr, period)
    sm_plus = rma(plus_dm, period)
    sm_minus = rma(minus_dm, period)
    plus_di, minus_di, dx = _none(size), _none(size), _none(size)
    for i in range(size):
        if sm_tr[i] in (None, 0) or sm_plus[i] is None or sm_minus[i] is None:
            continue
        plus_di[i] = 100.0 * sm_plus[i] / sm_tr[i]
        minus_di[i] = 100.0 * sm_minus[i] / sm_tr[i]
        denom = plus_di[i] + minus_di[i]
        dx[i] = 0.0 if denom == 0 else 100.0 * abs(plus_di[i] - minus_di[i]) / denom
    # ADX is the Wilder average of DX. Seed it on the first `period` DX values.
    adx = _none(size)
    dx_values = [(i, dx[i]) for i in range(size) if dx[i] is not None]
    if len(dx_values) >= period:
        seed_idx = dx_values[period - 1][0]
        seed = sum(v for _, v in dx_values[:period]) / period
        adx[seed_idx] = seed
        prev = seed
        for i, value in dx_values[period:]:
            prev = (prev * (period - 1) + value) / period
            adx[i] = prev
    return plus_di, minus_di, adx


def obv(close: list[float], volume: list[float]) -> list[float]:
    out = [volume[0] if volume else 0.0]
    for i in range(1, len(close)):
        if close[i] > close[i - 1]:
            out.append(out[-1] + volume[i])
        elif close[i] < close[i - 1]:
            out.append(out[-1] - volume[i])
        else:
            out.append(out[-1])
    return out


def rolling_vwap(high, low, close, volume, period: int = 20) -> list:
    out = _none(len(close))
    typical = [(high[i] + low[i] + close[i]) / 3.0 for i in range(len(close))]
    for i in range(period - 1, len(close)):
        vol = sum(volume[i - period + 1 : i + 1])
        if vol == 0:
            continue
        money = sum(typical[j] * volume[j] for j in range(i - period + 1, i + 1))
        out[i] = money / vol
    return out


def supertrend(high, low, close, period: int = 10, mult: float = 3.0):
    size = len(close)
    atr_values = atr(high, low, close, period)
    line = _none(size)
    direction = _none(size)
    final_upper = None
    final_lower = None
    for i in range(size):
        if atr_values[i] is None:
            continue
        hl2 = (high[i] + low[i]) / 2.0
        basic_upper = hl2 + mult * atr_values[i]
        basic_lower = hl2 - mult * atr_values[i]
        if final_upper is None:
            final_upper = basic_upper
            final_lower = basic_lower
            direction[i] = 1 if close[i] >= hl2 else -1
            line[i] = final_lower if direction[i] == 1 else final_upper
            continue
        prev_upper = final_upper
        prev_lower = final_lower
        prev_dir = direction[i - 1] if direction[i - 1] is not None else 1
        if basic_upper < prev_upper or close[i - 1] > prev_upper:
            final_upper = basic_upper
        else:
            final_upper = prev_upper
        if basic_lower > prev_lower or close[i - 1] < prev_lower:
            final_lower = basic_lower
        else:
            final_lower = prev_lower
        if prev_dir == 1:
            direction[i] = -1 if close[i] < final_lower else 1
        else:
            direction[i] = 1 if close[i] > final_upper else -1
        line[i] = final_lower if direction[i] == 1 else final_upper
    return line, direction


def cci(high, low, close, period: int = 20) -> list:
    out = _none(len(close))
    typical = [(high[i] + low[i] + close[i]) / 3.0 for i in range(len(close))]
    for i in range(period - 1, len(close)):
        window = typical[i - period + 1 : i + 1]
        mean = sum(window) / period
        mean_dev = sum(abs(x - mean) for x in window) / period
        out[i] = 0.0 if mean_dev == 0 else (typical[i] - mean) / (0.015 * mean_dev)
    return out


def trix(close: list[float], period: int = 12, signal_n: int = 9):
    e1 = ema(close, period)
    e2 = ema_optional(e1, period)
    e3 = ema_optional(e2, period)
    line = _none(len(close))
    for i in range(1, len(close)):
        if e3[i] is None or e3[i - 1] in (None, 0):
            continue
        line[i] = (e3[i] - e3[i - 1]) / abs(e3[i - 1]) * 100.0
    signal = ema_optional(line, signal_n)
    return line, signal


def bbi(close: list[float]) -> list:
    m3, m6, m12, m24 = sma(close, 3), sma(close, 6), sma(close, 12), sma(close, 24)
    out = _none(len(close))
    for i in range(len(close)):
        parts = [m3[i], m6[i], m12[i], m24[i]]
        if any(p is None for p in parts):
            continue
        out[i] = sum(parts) / 4.0
    return out


def mfi(high, low, close, volume, period: int = 14) -> list:
    out = _none(len(close))
    typical = [(high[i] + low[i] + close[i]) / 3.0 for i in range(len(close))]
    for i in range(period, len(close)):
        pos = 0.0
        neg = 0.0
        for j in range(i - period + 1, i + 1):
            flow = typical[j] * volume[j]
            if typical[j] > typical[j - 1]:
                pos += flow
            elif typical[j] < typical[j - 1]:
                neg += flow
        if neg == 0 and pos == 0:
            out[i] = 50.0
        elif neg == 0:
            out[i] = 100.0
        else:
            out[i] = 100.0 - 100.0 / (1.0 + pos / neg)
    return out


def cmf(high, low, close, volume, period: int = 20) -> list:
    out = _none(len(close))
    mult = []
    for i in range(len(close)):
        span = high[i] - low[i]
        mult.append(0.0 if span == 0 else ((close[i] - low[i]) - (high[i] - close[i])) / span)
    for i in range(period - 1, len(close)):
        vol = sum(volume[i - period + 1 : i + 1])
        if vol == 0:
            continue
        flow = sum(mult[j] * volume[j] for j in range(i - period + 1, i + 1))
        out[i] = flow / vol
    return out


def stoch_rsi(close: list[float], rsi_period: int = 14, stoch_period: int = 14, smooth: int = 3):
    rsi_values = rsi(close, rsi_period)
    raw = _none(len(close))
    for i in range(len(close)):
        window = [rsi_values[j] for j in range(i - stoch_period + 1, i + 1) if j >= 0]
        if len(window) < stoch_period or any(v is None for v in window):
            continue
        low = min(window)
        high = max(window)
        raw[i] = 50.0 if high == low else (rsi_values[i] - low) / (high - low) * 100.0
    k = sma_optional(raw, smooth)
    d = sma_optional(k, smooth)
    return k, d


def sma_optional(values: list, period: int) -> list:
    out = _none(len(values))
    for i in range(period - 1, len(values)):
        window = values[i - period + 1 : i + 1]
        if any(v is None for v in window):
            continue
        out[i] = sum(window) / period
    return out


def williams_r(high, low, close, period: int = 14) -> list:
    out = _none(len(close))
    for i in range(period - 1, len(close)):
        highest = max(high[i - period + 1 : i + 1])
        lowest = min(low[i - period + 1 : i + 1])
        out[i] = -50.0 if highest == lowest else (highest - close[i]) / (highest - lowest) * -100.0
    return out


def aroon(high, low, period: int = 25):
    up, down = _none(len(high)), _none(len(high))
    for i in range(period, len(high)):
        window_h = high[i - period : i + 1]
        window_l = low[i - period : i + 1]
        bars_since_high = window_h[::-1].index(max(window_h))
        bars_since_low = window_l[::-1].index(min(window_l))
        up[i] = 100.0 * (period - bars_since_high) / period
        down[i] = 100.0 * (period - bars_since_low) / period
    return up, down


def percentile_rank(series: list, index: int, lookback: int = 120) -> float | None:
    if index < 0 or series[index] is None:
        return None
    start = max(0, index - lookback + 1)
    window = [series[i] for i in range(start, index + 1) if series[i] is not None]
    if len(window) < 20:
        return None
    value = series[index]
    return 100.0 * sum(1 for item in window if item <= value) / len(window)


def compute(bars: list[dict]) -> dict:
    close = [b["c"] for b in bars]
    high = [b["h"] for b in bars]
    low = [b["l"] for b in bars]
    volume = [b["v"] or 0.0 for b in bars]
    macd_line, macd_signal, macd_hist = macd(close)
    k, d, j = kdj(high, low, close)
    bb_mid, bb_up, bb_low, bb_width, percent_b = bollinger(close)
    plus_di, minus_di, adx = dmi(high, low, close)
    st_line, st_dir = supertrend(high, low, close)
    trix_line, trix_signal = trix(close)
    stoch_k, stoch_d = stoch_rsi(close)
    aroon_up, aroon_down = aroon(high, low)
    return {
        "ema20": ema(close, 20),
        "ema50": ema(close, 50),
        "ema200": ema(close, 200),
        "macd": macd_line,
        "macd_signal": macd_signal,
        "macd_hist": macd_hist,
        "k": k,
        "d": d,
        "j": j,
        "rsi": rsi(close),
        "bb_mid": bb_mid,
        "bb_up": bb_up,
        "bb_low": bb_low,
        "bb_width": bb_width,
        "percent_b": percent_b,
        "plus_di": plus_di,
        "minus_di": minus_di,
        "adx": adx,
        "obv": obv(close, volume),
        "vwap": rolling_vwap(high, low, close, volume, 20),
        "supertrend": st_line,
        "supertrend_dir": st_dir,
        "cci": cci(high, low, close),
        "trix": trix_line,
        "trix_signal": trix_signal,
        "bbi": bbi(close),
        "atr": atr(high, low, close, 14),
        "mfi": mfi(high, low, close, volume),
        "cmf": cmf(high, low, close, volume),
        "stoch_k": stoch_k,
        "stoch_d": stoch_d,
        "williams": williams_r(high, low, close),
        "aroon_up": aroon_up,
        "aroon_down": aroon_down,
        "vol_ma": sma(volume, 20),
    }
