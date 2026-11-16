"""Bar resampling and session-close rules."""

from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
UTC = timezone.utc


def resample(bars: list[dict], bucket) -> list[dict]:
    groups: list[dict] = []
    current = None
    key = None
    for bar in bars:
        k = bucket(bar["t"])
        if current is None or k != key:
            if current is not None:
                groups.append(current)
            current = {
                "t": bar["t"],
                "o": bar["o"],
                "h": bar["h"],
                "l": bar["l"],
                "c": bar["c"],
                "v": bar["v"] or 0.0,
            }
            key = k
        else:
            current["h"] = max(current["h"], bar["h"])
            current["l"] = min(current["l"], bar["l"])
            current["c"] = bar["c"]
            current["v"] += bar["v"] or 0.0
    if current is not None:
        groups.append(current)
    return groups


def iso_week(ts: int) -> tuple[int, int]:
    dt = datetime.fromtimestamp(ts, UTC)
    year, week, _ = dt.isocalendar()
    return year, week


def to_weekly(daily_bars: list[dict]) -> list[dict]:
    return resample(daily_bars, iso_week)


def bar_is_closed(bar: dict, interval_sec: int, asset_class: str, now: float) -> bool:
    """A bar is closed only after its session (or its clock bucket) has ended."""
    if interval_sec >= 86400 * 5:
        now_key = iso_week(int(now))
        return iso_week(bar["t"]) != now_key and bar["t"] + interval_sec <= now + 2
    if asset_class != "crypto" and interval_sec >= 86400:
        start = datetime.fromtimestamp(bar["t"], NY)
        close = start.replace(hour=16, minute=0, second=0, microsecond=0)
        return now >= close.timestamp()
    return bar["t"] + interval_sec <= now + 1


def split_closed(bars: list[dict], interval_sec: int, asset_class: str, now: float) -> tuple[list[dict], dict | None]:
    if not bars:
        return [], None
    if bar_is_closed(bars[-1], interval_sec, asset_class, now):
        return bars, None
    if len(bars) == 1:
        return [], bars[-1]
    return bars[:-1], bars[-1]


def closed_weeks(daily_bars: list[dict], now: float) -> list[dict]:
    weeks = to_weekly(daily_bars)
    if not weeks:
        return []
    if iso_week(weeks[-1]["t"]) == iso_week(int(now)):
        return weeks[:-1]
    return weeks


def return_over(bars: list[dict], n: int = 20) -> float | None:
    if len(bars) <= n:
        return None
    start = bars[-1 - n]["c"]
    end = bars[-1]["c"]
    if not start:
        return None
    return end / start - 1.0
