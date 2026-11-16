"""Allowlisted public sources. No visitor-controlled URL is fetched."""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from email.utils import parsedate_to_datetime
from html import unescape
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
UA = "MarketDesk/1.0 (research; +https://localhost)"
BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
    "january": 1, "february": 2, "march": 3, "april": 4, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
}


class DataError(RuntimeError):
    pass


def _get(url: str, timeout: float = 5.5, accept: str = "*/*", user_agent: str = UA) -> bytes:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": user_agent, "Accept": accept, "Accept-Language": "en-US,en;q=0.9"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            data = response.read(3_500_000)
            if len(data) >= 3_500_000:
                raise DataError("上游响应过大")
            return data
    except urllib.error.HTTPError as exc:
        raise DataError(f"上游返回 {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise DataError("上游暂时不可达") from exc


def binance_bars(symbol: str, interval: str, limit: int = 400) -> list[dict]:
    query = urllib.parse.urlencode(
        {"symbol": symbol, "interval": interval, "limit": min(1000, max(20, int(limit)))}
    )
    payload = json.loads(
        _get(
            f"https://data-api.binance.vision/api/v3/klines?{query}",
            timeout=5.0,
            accept="application/json",
            user_agent=BROWSER_UA,
        )
    )
    if not isinstance(payload, list) or len(payload) < 5:
        raise DataError("Binance K 线为空")
    return [
        {
            "t": int(row[0]) // 1000,
            "o": float(row[1]),
            "h": float(row[2]),
            "l": float(row[3]),
            "c": float(row[4]),
            "v": float(row[5]),
        }
        for row in payload
    ]


def hyperliquid_bars(coin: str, interval: str, lookback_days: int = 730) -> list[dict]:
    now_ms = int(time.time() * 1000)
    body = json.dumps(
        {
            "type": "candleSnapshot",
            "req": {
                "coin": coin,
                "interval": interval,
                "startTime": now_ms - lookback_days * 86_400_000,
                "endTime": now_ms,
            },
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        "https://api.hyperliquid.xyz/info",
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": BROWSER_UA},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5.0) as response:
            rows = json.loads(response.read(3_500_000))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        raise DataError("Hyperliquid 暂时不可达") from exc
    if not isinstance(rows, list) or len(rows) < 5:
        raise DataError("Hyperliquid K 线为空")
    return [
        {
            "t": int(row["t"]) // 1000,
            "o": float(row["o"]),
            "h": float(row["h"]),
            "l": float(row["l"]),
            "c": float(row["c"]),
            "v": float(row["v"]),
        }
        for row in rows
    ]


def merge_bars_by_time(older_bars: list[dict] | None, newer_bars: list[dict] | None) -> list[dict]:
    if not older_bars:
        return list(newer_bars or [])
    if not newer_bars:
        return list(older_bars)
    cutoff = newer_bars[0]["t"]
    prefix = [bar for bar in older_bars if bar["t"] < cutoff]
    return prefix + list(newer_bars)


def _rows_from_yahoo(payload: dict) -> list[dict]:
    result = (payload.get("chart") or {}).get("result") or []
    if not result:
        error = (payload.get("chart") or {}).get("error") or {}
        raise DataError(error.get("description") or "行情为空")
    block = result[0]
    stamps = block.get("timestamp") or []
    quote = (block.get("indicators") or {}).get("quote") or [{}]
    q = quote[0]
    bars = []
    for i, ts in enumerate(stamps):
        o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        if None in (o, h, l, c):
            continue
        volume = q.get("volume", [None])[i] or 0.0
        bars.append({"t": int(ts), "o": float(o), "h": float(h), "l": float(l), "c": float(c), "v": float(volume)})
    if not bars:
        raise DataError("行情没有有效 K 线")
    return bars


def yahoo_bars(symbol: str, interval: str, range_: str) -> list[dict]:
    query = urllib.parse.urlencode(
        {"interval": interval, "range": range_, "includePrePost": "false", "events": "div|split"}
    )
    encoded = urllib.parse.quote(symbol, safe="")
    payload = json.loads(_get(f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}?{query}", timeout=5.0))
    return _rows_from_yahoo(payload)


def kraken_bars(pair: str, interval: int) -> list[dict]:
    payload = json.loads(_get(f"https://api.kraken.com/0/public/OHLC?pair={pair}&interval={int(interval)}", timeout=5.0))
    if payload.get("error"):
        raise DataError("Kraken 拒绝了这个交易对")
    result = payload.get("result") or {}
    key = next((k for k in result if k != "last"), None)
    if not key:
        raise DataError("Kraken 没有返回 K 线")
    bars = [
        {
            "t": int(row[0]),
            "o": float(row[1]),
            "h": float(row[2]),
            "l": float(row[3]),
            "c": float(row[4]),
            "v": float(row[6]),
        }
        for row in result[key]
    ]
    if len(bars) < 10:
        raise DataError("Kraken K 线太短")
    return bars


def funding_rate(inst_id: str) -> float | None:
    payload = json.loads(_get(f"https://www.okx.com/api/v5/public/funding-rate?instId={inst_id}", timeout=4.0))
    data = payload.get("data") or []
    if not data:
        return None
    return float(data[0]["fundingRate"])


def _parse_rfc822(value: str | None) -> int | None:
    if not value:
        return None
    try:
        dt = parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=NY)
    return int(dt.timestamp())


def google_news(query: str, edition: str = "zh") -> list[dict]:
    if edition == "zh":
        params = {"q": query, "hl": "zh-CN", "gl": "US", "ceid": "US:zh-Hans"}
    else:
        params = {"q": query, "hl": "en-US", "gl": "US", "ceid": "US:en"}
    url = "https://news.google.com/rss/search?" + urllib.parse.urlencode(params)
    root_bytes = _get(url, timeout=3.5, accept="application/rss+xml, application/xml, text/xml")
    import xml.etree.ElementTree as ET

    try:
        root = ET.fromstring(root_bytes)
    except ET.ParseError as exc:
        raise DataError("新闻源格式异常") from exc
    items = []
    for node in root.findall(".//item"):
        title = unescape((node.findtext("title") or "")).strip()[:300]
        link = (node.findtext("link") or "").strip()
        if not title or not link.startswith("https://"):
            continue
        source = node.findtext("source") or ""
        if not source and " - " in title:
            source = title.rsplit(" - ", 1)[-1]
        items.append(
            {
                "title": title,
                "url": link,
                "source": unescape(source).strip(),
                "t": _parse_rfc822(node.findtext("pubDate")),
            }
        )
    return items


def collect_news(queries: list[str], limit: int = 14) -> tuple[list[dict], list[str]]:
    found = []
    errors = []
    tasks = [(query, edition) for query in queries[:3] for edition in ("zh", "en")]
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(google_news, q, ed) for q, ed in tasks]
        for fut in futures:
            try:
                found.extend(fut.result())
            except DataError as exc:
                errors.append(str(exc))
    dedup = []
    seen = set()
    for item in found:
        key = re.sub(r"\s+", " ", item["title"]).casefold()
        if key in seen or item["t"] is None:
            continue
        seen.add(key)
        dedup.append(item)

    def rank(item: dict) -> tuple:
        title = item["title"].casefold()
        penalty = 1 if any(word in title for word in ("deadline", "law firm", "investor alert", "shareholder alert")) else 0
        return (penalty, -item["t"])

    dedup.sort(key=rank)
    return dedup[:limit], errors


def _bls_stamp(text: str) -> int | None:
    cleaned = text.replace(".", "")
    match = re.search(r"([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})", cleaned)
    if not match:
        return None
    month = MONTHS.get(match.group(1).lower())
    if not month:
        return None
    try:
        dt = datetime(int(match.group(3)), month, int(match.group(2)), 8, 30, tzinfo=NY)
    except ValueError:
        return None
    return int(dt.timestamp())


def parse_bls_release_table(html: str, kind: str, title: str) -> list[dict]:
    events = []
    for row in re.findall(r"<tr[\s\S]*?</tr>", html, flags=re.I):
        cells = re.findall(r"<td[^>]*>([\s\S]*?)</td>", row, flags=re.I)
        if len(cells) < 2:
            continue
        texts = [re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", cell))).strip() for cell in cells]
        stamp = _bls_stamp(texts[1])
        if stamp is None:
            continue
        events.append({"t": stamp, "kind": kind, "impact": "high", "title": title, "scope": "macro", "source": "bls.gov"})
    return events


def _fomc_decision(year: int, month_name: str, token: str) -> int | None:
    if "notation" in token.lower() or "/" in month_name:
        return None
    month = MONTHS.get(month_name.strip().lower())
    if not month:
        return None
    plain = token.replace("*", " ").strip()
    numbers = [int(n) for n in re.findall(r"\d+", plain)]
    if not numbers:
        return None
    start, end = numbers[0], numbers[-1]
    year_n, month_n = year, month
    if end < start:
        month_n += 1
        if month_n == 13:
            month_n = 1
            year_n += 1
    try:
        dt = datetime(year_n, month_n, end, 14, 0, tzinfo=NY)
    except ValueError:
        return None
    return int(dt.timestamp())


def parse_fomc(html: str) -> list[dict]:
    parts = re.split(r"(\d{4}) FOMC Meetings", html)
    events = []
    for i in range(1, len(parts) - 1, 2):
        year = int(parts[i])
        if year < 2026 or year > 2027:
            continue
        body = parts[i + 1]
        meetings = re.findall(
            r"<strong>([A-Za-z/]+)</strong>[\s\S]{0,400}?fomc-meeting__date[\s\S]{0,200}?>([^<]+)<",
            body,
        )
        for month_name, token in meetings:
            stamp = _fomc_decision(year, month_name, token)
            if stamp is None:
                continue
            sep = "*" in token
            events.append(
                {
                    "t": stamp,
                    "kind": "fomc",
                    "impact": "high",
                    "title": "FOMC 利率决议" + ("（含经济预测）" if sep else ""),
                    "scope": "macro",
                    "source": "federalreserve.gov",
                }
            )
    return events


def parse_bitbo_flows(html: str) -> list[dict]:
    rows = []
    for row in re.findall(r"<tr[\s\S]*?</tr>", html, flags=re.I):
        cells = re.findall(r"<t[dh][^>]*>([\s\S]*?)</t[dh]>", row, flags=re.I)
        texts = [re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", c)).replace("\xa0", " ")).strip() for c in cells]
        if len(texts) < 3:
            continue
        match = re.match(r"^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$", texts[0])
        if not match:
            continue
        month = MONTHS.get(match.group(1).lower())
        if not month:
            continue
        numbers = []
        for cell in texts[1:]:
            if cell in {"", "-", "—"}:
                continue
            negative = cell.startswith("(") or cell.startswith("-")
            cleaned = cell.replace("(", "").replace(")", "").replace(",", "").replace("+", "").replace("$", "")
            try:
                value = float(cleaned)
            except ValueError:
                continue
            numbers.append(-abs(value) if negative else value)
        if not numbers:
            continue
        try:
            dt = datetime(int(match.group(3)), month, int(match.group(2)), 21, 0, tzinfo=NY)
        except ValueError:
            continue
        rows.append(
            {
                "t": int(dt.timestamp()),
                "ibit_musd": numbers[0] if len(numbers) >= 2 else None,
                "fbtc_musd": numbers[1] if len(numbers) >= 3 else None,
                "total_musd": numbers[-1],
            }
        )
    rows.sort(key=lambda item: item["t"])
    dedup, seen = [], set()
    for row in rows:
        if row["t"] not in seen:
            seen.add(row["t"])
            dedup.append(row)
    return dedup


def parse_farside(html: str) -> list[dict]:
    rows = []
    for row in re.findall(r"<tr[\s\S]*?</tr>", html, flags=re.I):
        cells = re.findall(r"<t[dh][^>]*>([\s\S]*?)</t[dh]>", row, flags=re.I)
        texts = []
        for cell in cells:
            text = unescape(re.sub(r"<[^>]+>", " ", cell)).replace("\xa0", " ")
            texts.append(re.sub(r"\s+", " ", text).strip())
        if not texts:
            continue
        match = re.match(r"(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})", texts[0])
        if not match:
            continue
        month = MONTHS.get(match.group(2).lower())
        if not month:
            continue
        numbers = []
        for cell in texts[1:]:
            if cell in {"", "-"}:
                continue
            negative = cell.startswith("(") or cell.startswith("-")
            cleaned = cell.replace("(", "").replace(")", "").replace(",", "").replace("+", "")
            try:
                value = float(cleaned)
            except ValueError:
                continue
            numbers.append(-abs(value) if negative else value)
        if not numbers:
            continue
        try:
            dt = datetime(int(match.group(3)), month, int(match.group(1)), 21, 0, tzinfo=NY)
        except ValueError:
            continue
        rows.append({"t": int(dt.timestamp()), "total_musd": numbers[-1]})
    rows.sort(key=lambda item: item["t"])
    dedup, seen = [], set()
    for row in rows:
        if row["t"] not in seen:
            seen.add(row["t"])
            dedup.append(row)
    return dedup


def fetch_etf_flows() -> list[dict]:
    try:
        html = _get("https://bitbo.io/treasuries/etf-flows/", timeout=5.0, accept="text/html", user_agent=BROWSER_UA).decode("utf-8", "replace")
        rows = parse_bitbo_flows(html)
        if len(rows) >= 5:
            return rows
    except DataError:
        pass
    html = _get("https://farside.co.uk/btc/", timeout=5.0, accept="text/html", user_agent=UA).decode("utf-8", "replace")
    rows = parse_farside(html)
    if len(rows) < 5:
        raise DataError("ETF 资金表没有解析出足够的行")
    return rows


def _nasdaq_earnings(symbol: str) -> str | None:
    payload = json.loads(
        _get(
            f"https://api.nasdaq.com/api/quote/{urllib.parse.quote(symbol)}/info?assetclass=stocks",
            timeout=2.5,
            accept="application/json",
            user_agent="Mozilla/5.0",
        )
    )
    notes = ((payload.get("data") or {}).get("notifications")) or []
    for note in notes:
        for event in note.get("eventTypes") or []:
            message = event.get("message") or ""
            match = re.search(r"Earnings Date\s*:\s*([A-Za-z]+\.?\s+\d{1,2},\s*\d{4})", message)
            if match:
                stamp = _bls_stamp(match.group(1))
                if stamp:
                    return datetime.fromtimestamp(stamp, NY).strftime("%Y-%m-%d")
    return None


def _yahoo_earnings(symbol: str) -> dict | None:
    html = _get(f"https://finance.yahoo.com/quote/{urllib.parse.quote(symbol)}/", timeout=3.5, accept="text/html").decode("utf-8", "replace")
    idx = html.find("earningsDate")
    if idx < 0:
        return None
    chunk = html[idx : idx + 500]
    dates = re.findall(r"20\d{2}-\d{2}-\d{2}", chunk)
    if not dates:
        return None
    flag = chunk[chunk.find("isEarningsDateEstimate") : chunk.find("isEarningsDateEstimate") + 40]
    return {"date": dates[0], "estimate": "true" in flag}


def fetch_earnings_fast(symbol: str) -> dict | None:
    try:
        nasdaq = _nasdaq_earnings(symbol)
    except DataError:
        return None
    if not nasdaq:
        return None
    year, month, day = [int(part) for part in nasdaq.split("-")]
    stamp = int(datetime(year, month, day, 9, 30, tzinfo=NY).timestamp())
    return {"t": stamp, "date": nasdaq, "estimate": False, "symbol": symbol}


def fetch_earnings(symbol: str) -> dict | None:
    fast = fetch_earnings_fast(symbol)
    if fast:
        return fast
    try:
        yahoo = _yahoo_earnings(symbol)
    except DataError:
        return None
    if not yahoo:
        return None
    year, month, day = [int(part) for part in yahoo["date"].split("-")]
    stamp = int(datetime(year, month, day, 9, 30, tzinfo=NY).timestamp())
    return {"t": stamp, "date": yahoo["date"], "estimate": yahoo["estimate"], "symbol": symbol}


def _ny(year, month, day, hour, minute=0) -> int:
    return int(datetime(year, month, day, hour, minute, tzinfo=NY).timestamp())


FALLBACK_EVENTS = [
    {"t": _ny(2026, 9, 16, 14), "kind": "fomc", "impact": "high", "title": "FOMC 利率决议（含经济预测）", "scope": "macro", "source": "federalreserve.gov"},
    {"t": _ny(2026, 10, 2, 8, 30), "kind": "nfp", "impact": "high", "title": "美国非农就业", "scope": "macro", "source": "bls.gov"},
    {"t": _ny(2026, 10, 14, 8, 30), "kind": "cpi", "impact": "high", "title": "美国 CPI", "scope": "macro", "source": "bls.gov"},
    {"t": _ny(2026, 10, 15, 8, 30), "kind": "ppi", "impact": "high", "title": "美国 PPI", "scope": "macro", "source": "bls.gov"},
    {"t": _ny(2026, 10, 28, 14), "kind": "fomc", "impact": "high", "title": "FOMC 利率决议", "scope": "macro", "source": "federalreserve.gov"},
    {"t": _ny(2026, 11, 6, 8, 30), "kind": "nfp", "impact": "high", "title": "美国非农就业", "scope": "macro", "source": "bls.gov"},
    {"t": _ny(2026, 11, 10, 8, 30), "kind": "cpi", "impact": "high", "title": "美国 CPI", "scope": "macro", "source": "bls.gov"},
    {"t": _ny(2026, 11, 13, 8, 30), "kind": "ppi", "impact": "high", "title": "美国 PPI", "scope": "macro", "source": "bls.gov"},
    {"t": _ny(2026, 12, 4, 8, 30), "kind": "nfp", "impact": "high", "title": "美国非农就业", "scope": "macro", "source": "bls.gov"},
    {"t": _ny(2026, 12, 9, 14), "kind": "fomc", "impact": "high", "title": "FOMC 利率决议（含经济预测）", "scope": "macro", "source": "federalreserve.gov"},
    {"t": _ny(2026, 12, 10, 8, 30), "kind": "cpi", "impact": "high", "title": "美国 CPI", "scope": "macro", "source": "bls.gov"},
    {"t": _ny(2026, 12, 15, 8, 30), "kind": "ppi", "impact": "high", "title": "美国 PPI", "scope": "macro", "source": "bls.gov"},
    {"t": _ny(2027, 1, 8, 8, 30), "kind": "nfp", "impact": "high", "title": "美国非农就业", "scope": "macro", "source": "bls.gov"},
    {"t": _ny(2027, 1, 13, 8, 30), "kind": "cpi", "impact": "high", "title": "美国 CPI", "scope": "macro", "source": "bls.gov"},
    {"t": _ny(2027, 1, 27, 14), "kind": "fomc", "impact": "high", "title": "FOMC 利率决议", "scope": "macro", "source": "federalreserve.gov"},
]


def fast_fallback_calendar() -> tuple[list[dict], list[str]]:
    dedup, seen = [], set()
    for event in sorted(FALLBACK_EVENTS, key=lambda item: item["t"]):
        key = (event["kind"], datetime.fromtimestamp(event["t"], NY).strftime("%Y-%m-%d"))
        if key in seen:
            continue
        seen.add(key)
        when = datetime.fromtimestamp(event["t"], NY).strftime("%m-%d %H:%M")
        row = dict(event)
        row["title"] = f"{row['title']} · 美东 {when}"
        dedup.append(row)
    return dedup, []


def fetch_macro_calendar() -> tuple[list[dict], list[str]]:
    notes = []
    collected = list(FALLBACK_EVENTS)
    pages = [
        ("https://www.bls.gov/schedule/news_release/cpi.htm", "cpi", "美国 CPI"),
        ("https://www.bls.gov/schedule/news_release/empsit.htm", "nfp", "美国非农就业"),
        ("https://www.bls.gov/schedule/news_release/ppi.htm", "ppi", "美国 PPI"),
    ]
    for url, kind, title in pages:
        try:
            html = _get(url, timeout=4.5, accept="text/html").decode("utf-8", "replace")
            parsed = parse_bls_release_table(html, kind, title)
            if len(parsed) >= 4:
                collected.extend(parsed)
            else:
                notes.append(f"{title}页面行数不足，保留已核对日期")
        except DataError:
            notes.append(f"{title}页面暂时取不到，使用已核对日期")
    try:
        html = _get("https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", timeout=4.5, accept="text/html").decode("utf-8", "replace")
        parsed = parse_fomc(html)
        if len(parsed) >= 6:
            collected.extend(parsed)
        else:
            notes.append("FOMC 页面解析不完整，保留已核对日期")
    except DataError:
        notes.append("FOMC 页面暂时取不到，使用已核对日期")
    dedup, seen = [], set()
    start = int(datetime(2026, 1, 1, tzinfo=NY).timestamp())
    end = int(datetime(2028, 1, 1, tzinfo=NY).timestamp())
    for event in sorted(collected, key=lambda item: item["t"]):
        if not start <= event["t"] < end:
            continue
        key = (event["kind"], datetime.fromtimestamp(event["t"], NY).strftime("%Y-%m-%d"))
        if key in seen:
            continue
        seen.add(key)
        when = datetime.fromtimestamp(event["t"], NY).strftime("%m-%d %H:%M")
        row = dict(event)
        row["title"] = f"{row['title']} · 美东 {when}"
        dedup.append(row)
    return dedup, notes
