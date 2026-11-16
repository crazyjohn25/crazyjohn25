import { formatMDHM, formatYMD, nyStamp, NY } from "./time.mjs";

const UA = "MarketDesk/1.0 (research; +https://localhost)";
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
};

export class DataError extends Error {}

function unescapeHtml(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, ent) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return Object.prototype.hasOwnProperty.call(NAMED, ent) ? NAMED[ent] : all;
  });
}

function sameHost(next, prev) {
  return next.protocol === "https:" && next.host === prev.host;
}

async function getBytes(url, accept = "*/*", timeout = 5500, hops = 0, userAgent = UA) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": userAgent, Accept: accept, "Accept-Language": "en-US,en;q=0.9" },
      signal: controller.signal,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || hops >= 2) throw new DataError("上游暂时不可达");
      const next = new URL(location, url);
      if (!sameHost(next, new URL(url))) throw new DataError("上游暂时不可达");
      return getBytes(next.toString(), accept, timeout, hops + 1, userAgent);
    }
    if (!response.ok) throw new DataError(`上游返回 ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength >= 3_500_000) throw new DataError("上游响应过大");
    return bytes;
  } catch (error) {
    if (error instanceof DataError) throw error;
    throw new DataError("上游暂时不可达");
  } finally {
    clearTimeout(timer);
  }
}

async function getText(url, accept = "*/*", timeout = 5500, userAgent = UA) {
  const bytes = await getBytes(url, accept, timeout, 0, userAgent);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

async function getJson(url, accept = "application/json", timeout = 5500, userAgent = UA) {
  return JSON.parse(await getText(url, accept, timeout, userAgent));
}

export async function binanceBars(symbol, interval, limit = 400) {
  const query = new URLSearchParams({
    symbol,
    interval,
    limit: String(Math.min(1000, Math.max(20, limit))),
  });
  const rows = await getJson(`https://data-api.binance.vision/api/v3/klines?${query}`, "application/json", 5000, BROWSER_UA);
  if (!Array.isArray(rows) || rows.length < 5) throw new DataError("Binance K 线为空");
  return rows.map((row) => ({
    t: Math.floor(Number(row[0]) / 1000),
    o: Number(row[1]),
    h: Number(row[2]),
    l: Number(row[3]),
    c: Number(row[4]),
    v: Number(row[5]),
  }));
}

export async function hyperliquidBars(coin, interval, lookbackDays = 730) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const now = Date.now();
  try {
    const response = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({
        type: "candleSnapshot",
        req: { coin, interval, startTime: now - lookbackDays * 86_400_000, endTime: now },
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new DataError(`Hyperliquid 返回 ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length < 5) throw new DataError("Hyperliquid K 线为空");
    return rows.map((row) => ({
      t: Math.floor(Number(row.t) / 1000),
      o: Number(row.o),
      h: Number(row.h),
      l: Number(row.l),
      c: Number(row.c),
      v: Number(row.v),
    }));
  } catch (error) {
    if (error instanceof DataError) throw error;
    throw new DataError("Hyperliquid 暂时不可达");
  } finally {
    clearTimeout(timer);
  }
}

export function mergeBarsByTime(olderBars, newerBars) {
  if (!olderBars?.length) return newerBars || [];
  if (!newerBars?.length) return olderBars;
  const cutoff = newerBars[0].t;
  const prefix = olderBars.filter((bar) => bar.t < cutoff);
  return [...prefix, ...newerBars];
}

function rowsFromYahoo(payload) {
  const result = payload.chart?.result || [];
  if (!result.length) throw new DataError(payload.chart?.error?.description || "行情为空");
  const block = result[0];
  const stamps = block.timestamp || [];
  const quote = block.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < stamps.length; i += 1) {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    bars.push({ t: Number(stamps[i]), o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(quote.volume?.[i] || 0) });
  }
  if (!bars.length) throw new DataError("行情没有有效 K 线");
  return bars;
}

export async function yahooBars(symbol, interval, range) {
  const query = new URLSearchParams({ interval, range, includePrePost: "false", events: "div|split" });
  const payload = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`, "*/*", 5000);
  return rowsFromYahoo(payload);
}

export async function krakenBars(pair, interval) {
  const payload = await getJson(`https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=${Number(interval)}`, "application/json", 5000);
  if (payload.error?.length) throw new DataError("Kraken 拒绝了这个交易对");
  const result = payload.result || {};
  const key = Object.keys(result).find((name) => name !== "last");
  if (!key) throw new DataError("Kraken 没有返回 K 线");
  const bars = result[key].map((row) => ({
    t: Number(row[0]),
    o: Number(row[1]),
    h: Number(row[2]),
    l: Number(row[3]),
    c: Number(row[4]),
    v: Number(row[6]),
  }));
  if (bars.length < 10) throw new DataError("Kraken K 线太短");
  return bars;
}

export async function fundingRate(instId) {
  const payload = await getJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`, "application/json", 4000);
  const data = payload.data || [];
  if (!data.length) return null;
  return Number(data[0].fundingRate);
}

function textOf(block, tag) {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!match) return "";
  let text = match[1].trim();
  if (text.startsWith("<![CDATA[")) text = text.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
  return unescapeHtml(text).trim();
}

export async function googleNews(query, edition = "zh") {
  const params = edition === "zh"
    ? new URLSearchParams({ q: query, hl: "zh-CN", gl: "US", ceid: "US:zh-Hans" })
    : new URLSearchParams({ q: query, hl: "en-US", gl: "US", ceid: "US:en" });
  const xml = await getText(`https://news.google.com/rss/search?${params}`, "application/rss+xml, application/xml, text/xml", 3500);
  if (!xml.includes("<item")) throw new DataError("新闻源格式异常");
  const items = [];
  for (const block of xml.match(/<item\b[\s\S]*?<\/item>/gi) || []) {
    let title = textOf(block, "title");
    const link = textOf(block, "link");
    if (!title || !link.startsWith("https://")) continue;
    title = title.slice(0, 300);
    let source = textOf(block, "source");
    if (!source && title.includes(" - ")) source = title.split(" - ").at(-1);
    const pub = textOf(block, "pubDate");
    const parsed = pub ? Date.parse(pub) : Number.NaN;
    items.push({
      title,
      url: new URL(link).protocol === "https:" ? new URL(link).toString() : link,
      source,
      t: Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null,
    });
  }
  return items;
}

export async function collectNews(queries, limit = 14) {
  const found = [];
  const errors = [];
  const jobs = [];
  for (const query of queries.slice(0, 3)) {
    for (const edition of ["zh", "en"]) {
      jobs.push(
        googleNews(query, edition)
          .then((rows) => found.push(...rows))
          .catch((error) => {
            errors.push(error instanceof DataError ? error.message : "上游暂时不可达");
          }),
      );
    }
  }
  await Promise.all(jobs);
  const dedup = [];
  const seen = new Set();
  for (const item of found) {
    const key = item.title.replace(/\s+/g, " ").toLowerCase();
    if (seen.has(key) || item.t == null) continue;
    seen.add(key);
    dedup.push(item);
  }
  dedup.sort((a, b) => {
    const penalty = (title) =>
      ["deadline", "law firm", "investor alert", "shareholder alert"].some((word) => title.toLowerCase().includes(word)) ? 1 : 0;
    const left = penalty(a.title) - penalty(b.title);
    return left || b.t - a.t;
  });
  return [dedup.slice(0, limit), errors];
}

function blsStamp(text) {
  const match = text.replaceAll(".", "").match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  if (!month) return null;
  return nyStamp(Number(match[3]), month, Number(match[2]), 8, 30);
}

export function parseBlsReleaseTable(html, kind, title) {
  const events = [];
  for (const row of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
    if (cells.length < 2) continue;
    const texts = cells.map((cell) => unescapeHtml(cell.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim());
    const stamp = blsStamp(texts[1]);
    if (stamp == null) continue;
    events.push({ t: stamp, kind, impact: "high", title, scope: "macro", source: "bls.gov" });
  }
  return events;
}

function fomcDecision(year, monthName, token) {
  if (token.toLowerCase().includes("notation") || monthName.includes("/")) return null;
  const month = MONTHS[monthName.trim().toLowerCase()];
  if (!month) return null;
  const numbers = (token.replaceAll("*", " ").match(/\d+/g) || []).map(Number);
  if (!numbers.length) return null;
  const start = numbers[0];
  const end = numbers[numbers.length - 1];
  let yearN = year;
  let monthN = month;
  if (end < start) {
    monthN += 1;
    if (monthN === 13) {
      monthN = 1;
      yearN += 1;
    }
  }
  return nyStamp(yearN, monthN, end, 14, 0);
}

export function parseFomc(html) {
  const parts = html.split(/(\d{4}) FOMC Meetings/);
  const events = [];
  for (let i = 1; i < parts.length - 1; i += 2) {
    const year = Number(parts[i]);
    if (year < 2026 || year > 2027) continue;
    const body = parts[i + 1];
    const meetings = [...body.matchAll(/<strong>([A-Za-z/]+)<\/strong>[\s\S]{0,400}?fomc-meeting__date[\s\S]{0,200}?>([^<]+)</g)];
    for (const match of meetings) {
      const stamp = fomcDecision(year, match[1], match[2]);
      if (stamp == null) continue;
      events.push({
        t: stamp,
        kind: "fomc",
        impact: "high",
        title: `FOMC 利率决议${match[2].includes("*") ? "（含经济预测）" : ""}`,
        scope: "macro",
        source: "federalreserve.gov",
      });
    }
  }
  return events;
}

export function parseBitboFlows(html) {
  const rows = [];
  for (const row of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => match[1]);
    const texts = cells.map((cell) => unescapeHtml(cell.replace(/<[^>]+>/g, " ")).replaceAll("\u00a0", " ").replace(/\s+/g, " ").trim());
    if (texts.length < 3) continue;
    const match = texts[0].match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$/);
    if (!match) continue;
    const month = MONTHS[match[1].toLowerCase()];
    if (!month) continue;
    const numbers = [];
    for (const cell of texts.slice(1)) {
      if (cell === "" || cell === "-" || cell === "—") continue;
      const negative = cell.startsWith("(") || cell.startsWith("-");
      const cleaned = cell.replaceAll("(", "").replaceAll(")", "").replaceAll(",", "").replaceAll("+", "").replaceAll("$", "");
      const value = Number(cleaned);
      if (!Number.isFinite(value)) continue;
      numbers.push(negative ? -Math.abs(value) : value);
    }
    if (!numbers.length) continue;
    const stamp = nyStamp(Number(match[3]), month, Number(match[2]), 21, 0);
    if (stamp == null) continue;
    rows.push({
      t: stamp,
      ibit_musd: numbers.length >= 2 ? numbers[0] : null,
      fbtc_musd: numbers.length >= 3 ? numbers[1] : null,
      total_musd: numbers[numbers.length - 1],
    });
  }
  rows.sort((a, b) => a.t - b.t);
  const dedup = [];
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.t)) continue;
    seen.add(row.t);
    dedup.push(row);
  }
  return dedup;
}

export function parseFarside(html) {
  const rows = [];
  for (const row of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => match[1]);
    const texts = cells.map((cell) => unescapeHtml(cell.replace(/<[^>]+>/g, " ")).replaceAll("\u00a0", " ").replace(/\s+/g, " ").trim());
    if (!texts.length) continue;
    const match = texts[0].match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
    if (!match) continue;
    const month = MONTHS[match[2].toLowerCase()];
    if (!month) continue;
    const numbers = [];
    for (const cell of texts.slice(1)) {
      if (cell === "" || cell === "-") continue;
      const negative = cell.startsWith("(") || cell.startsWith("-");
      const cleaned = cell.replaceAll("(", "").replaceAll(")", "").replaceAll(",", "").replaceAll("+", "");
      const value = Number(cleaned);
      if (!Number.isFinite(value)) continue;
      numbers.push(negative ? -Math.abs(value) : value);
    }
    if (!numbers.length) continue;
    const stamp = nyStamp(Number(match[3]), month, Number(match[1]), 21, 0);
    if (stamp == null) continue;
    rows.push({ t: stamp, total_musd: numbers[numbers.length - 1] });
  }
  rows.sort((a, b) => a.t - b.t);
  const dedup = [];
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.t)) continue;
    seen.add(row.t);
    dedup.push(row);
  }
  return dedup;
}

export async function fetchEtfFlows() {
  try {
    const html = await getText("https://bitbo.io/treasuries/etf-flows/", "text/html", 5000, BROWSER_UA);
    const rows = parseBitboFlows(html);
    if (rows.length >= 5) return rows;
  } catch (error) {
    if (!(error instanceof DataError)) throw error;
  }
  const html = await getText("https://farside.co.uk/btc/", "text/html", 5000, UA);
  const rows = parseFarside(html);
  if (rows.length < 5) throw new DataError("ETF 资金表没有解析出足够的行");
  return rows;
}

async function nasdaqEarnings(symbol) {
  const payload = await getJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=stocks`, "application/json", 2500, "Mozilla/5.0");
  const notes = payload.data?.notifications || [];
  for (const note of notes) {
    for (const event of note.eventTypes || []) {
      const message = event.message || "";
      const match = message.match(/Earnings Date\s*:\s*([A-Za-z]+\.?\s+\d{1,2},\s*\d{4})/);
      if (!match) continue;
      const stamp = blsStamp(match[1]);
      if (stamp) return formatYMD(stamp, NY);
    }
  }
  return null;
}

async function yahooEarnings(symbol) {
  const html = await getText(`https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`, "text/html", 3500);
  const idx = html.indexOf("earningsDate");
  if (idx < 0) return null;
  const chunk = html.slice(idx, idx + 500);
  const dates = chunk.match(/20\d{2}-\d{2}-\d{2}/g);
  if (!dates) return null;
  const flagAt = chunk.indexOf("isEarningsDateEstimate");
  const flag = flagAt < 0 ? "" : chunk.slice(flagAt, flagAt + 40);
  return { date: dates[0], estimate: flag.includes("true") };
}

export async function fetchEarnings(symbol) {
  let nasdaq = null;
  try {
    nasdaq = await nasdaqEarnings(symbol);
  } catch (error) {
    if (!(error instanceof DataError)) throw error;
  }
  if (nasdaq) {
    const [year, month, day] = nasdaq.split("-").map(Number);
    const stamp = nyStamp(year, month, day, 9, 30);
    if (stamp != null) return { t: stamp, date: nasdaq, estimate: false, symbol };
  }
  try {
    const yahoo = await yahooEarnings(symbol);
    if (!yahoo) return null;
    const [year, month, day] = yahoo.date.split("-").map(Number);
    const stamp = nyStamp(year, month, day, 9, 30);
    if (stamp == null) return null;
    return { t: stamp, date: yahoo.date, estimate: yahoo.estimate, symbol };
  } catch (error) {
    if (!(error instanceof DataError)) throw error;
    return null;
  }
}

export const FALLBACK_EVENTS = [
  { t: nyStamp(2026, 9, 16, 14), kind: "fomc", impact: "high", title: "FOMC 利率决议（含经济预测）", scope: "macro", source: "federalreserve.gov" },
  { t: nyStamp(2026, 10, 2, 8, 30), kind: "nfp", impact: "high", title: "美国非农就业", scope: "macro", source: "bls.gov" },
  { t: nyStamp(2026, 10, 14, 8, 30), kind: "cpi", impact: "high", title: "美国 CPI", scope: "macro", source: "bls.gov" },
  { t: nyStamp(2026, 10, 15, 8, 30), kind: "ppi", impact: "high", title: "美国 PPI", scope: "macro", source: "bls.gov" },
  { t: nyStamp(2026, 10, 28, 14), kind: "fomc", impact: "high", title: "FOMC 利率决议", scope: "macro", source: "federalreserve.gov" },
  { t: nyStamp(2026, 11, 6, 8, 30), kind: "nfp", impact: "high", title: "美国非农就业", scope: "macro", source: "bls.gov" },
  { t: nyStamp(2026, 11, 10, 8, 30), kind: "cpi", impact: "high", title: "美国 CPI", scope: "macro", source: "bls.gov" },
  { t: nyStamp(2026, 11, 13, 8, 30), kind: "ppi", impact: "high", title: "美国 PPI", scope: "macro", source: "bls.gov" },
  { t: nyStamp(2026, 12, 4, 8, 30), kind: "nfp", impact: "high", title: "美国非农就业", scope: "macro", source: "bls.gov" },
  { t: nyStamp(2026, 12, 9, 14), kind: "fomc", impact: "high", title: "FOMC 利率决议（含经济预测）", scope: "macro", source: "federalreserve.gov" },
  { t: nyStamp(2026, 12, 10, 8, 30), kind: "cpi", impact: "high", title: "美国 CPI", scope: "macro", source: "bls.gov" },
  { t: nyStamp(2026, 12, 15, 8, 30), kind: "ppi", impact: "high", title: "美国 PPI", scope: "macro", source: "bls.gov" },
  { t: nyStamp(2027, 1, 8, 8, 30), kind: "nfp", impact: "high", title: "美国非农就业", scope: "macro", source: "bls.gov" },
  { t: nyStamp(2027, 1, 13, 8, 30), kind: "cpi", impact: "high", title: "美国 CPI", scope: "macro", source: "bls.gov" },
  { t: nyStamp(2027, 1, 27, 14), kind: "fomc", impact: "high", title: "FOMC 利率决议", scope: "macro", source: "federalreserve.gov" },
];

export function fastFallbackCalendar() {
  const dedup = [];
  const seen = new Set();
  for (const event of [...FALLBACK_EVENTS].sort((a, b) => a.t - b.t)) {
    const key = `${event.kind}:${formatYMD(event.t, NY)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push({ ...event, title: `${event.title} · 美东 ${formatMDHM(event.t, NY)}` });
  }
  return [dedup, []];
}

export async function fetchEarningsFast(symbol) {
  try {
    const nasdaq = await nasdaqEarnings(symbol);
    if (!nasdaq) return null;
    const [year, month, day] = nasdaq.split("-").map(Number);
    const stamp = nyStamp(year, month, day, 9, 30);
    if (stamp == null) return null;
    return { t: stamp, date: nasdaq, estimate: false, symbol };
  } catch (error) {
    if (!(error instanceof DataError)) throw error;
    return null;
  }
}

export async function fetchMacroCalendar() {
  const notes = [];
  const collected = FALLBACK_EVENTS.map((event) => ({ ...event }));
  const pages = [
    ["https://www.bls.gov/schedule/news_release/cpi.htm", "cpi", "美国 CPI"],
    ["https://www.bls.gov/schedule/news_release/empsit.htm", "nfp", "美国非农就业"],
    ["https://www.bls.gov/schedule/news_release/ppi.htm", "ppi", "美国 PPI"],
  ];
  await Promise.all(
    pages.map(async ([url, kind, title]) => {
      try {
        const html = await getText(url, "text/html", 4500);
        const parsed = parseBlsReleaseTable(html, kind, title);
        if (parsed.length >= 4) collected.push(...parsed);
        else notes.push(`${title}页面行数不足，保留已核对日期`);
      } catch (error) {
        if (!(error instanceof DataError)) throw error;
        notes.push(`${title}页面暂时取不到，使用已核对日期`);
      }
    }),
  );
  try {
    const html = await getText("https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", "text/html", 4500);
    const parsed = parseFomc(html);
    if (parsed.length >= 6) collected.push(...parsed);
    else notes.push("FOMC 页面解析不完整，保留已核对日期");
  } catch (error) {
    if (!(error instanceof DataError)) throw error;
    notes.push("FOMC 页面暂时取不到，使用已核对日期");
  }
  const start = nyStamp(2026, 1, 1, 0, 0);
  const end = nyStamp(2028, 1, 1, 0, 0);
  const dedup = [];
  const seen = new Set();
  for (const event of collected.sort((a, b) => a.t - b.t)) {
    if (event.t < start || event.t >= end) continue;
    const key = `${event.kind}:${formatYMD(event.t, NY)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push({ ...event, title: `${event.title} · 美东 ${formatMDHM(event.t, NY)}` });
  }
  return [dedup, notes];
}
