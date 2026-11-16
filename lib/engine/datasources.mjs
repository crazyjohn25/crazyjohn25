import { formatMDHM, formatYMD, nyStamp, NY } from "./time.mjs";

const UA = "MarketDesk/1.0 (research; +https://localhost)";
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

async function getBytes(url, accept = "*/*", timeout = 8000, hops = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "en-US,en;q=0.9" },
      signal: controller.signal,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || hops >= 2) throw new DataError("上游暂时不可达");
      const next = new URL(location, url);
      if (!sameHost(next, new URL(url))) throw new DataError("上游暂时不可达");
      return getBytes(next.toString(), accept, timeout, hops + 1);
    }
    if (!response.ok) throw new DataError(`上游返回 ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength >= 2_500_000) throw new DataError("上游响应过大");
    return bytes;
  } catch (error) {
    if (error instanceof DataError) throw error;
    throw new DataError("上游暂时不可达");
  } finally {
    clearTimeout(timer);
  }
}

async function getText(url, accept) {
  const bytes = await getBytes(url, accept);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

async function getJson(url, accept = "application/json") {
  return JSON.parse(await getText(url, accept));
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
  const payload = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`, "*/*");
  return rowsFromYahoo(payload);
}

export async function yahooPrivateMark(symbol) {
  const payload = await getJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y&includePrePost=false`,
    "*/*",
  );
  const result = payload.chart?.result || [];
  if (!result.length) throw new DataError("没有私人公司参考价");
  const meta = result[0].meta || {};
  if (meta.regularMarketPrice == null) throw new DataError("没有私人公司参考价");
  return {
    price: Number(meta.regularMarketPrice),
    t: Number(meta.regularMarketTime || Math.floor(Date.now() / 1000)),
    name: meta.longName || meta.shortName || symbol,
    currency: meta.currency || "USD",
  };
}

export async function krakenBars(pair, interval) {
  const payload = await getJson(`https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=${Number(interval)}`);
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
  const payload = await getJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`);
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
  const xml = await getText(`https://news.google.com/rss/search?${params}`, "application/rss+xml, application/xml, text/xml");
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

export async function collectNews(queries, limit = 16) {
  const found = [];
  const errors = [];
  const jobs = [];
  for (const query of queries) {
    for (const edition of ["zh", "en"]) {
      jobs.push(
        googleNews(query, edition).then((rows) => found.push(...rows)).catch((error) => {
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
    const penalty = (title) => ["deadline", "law firm", "investor alert", "shareholder alert"].some((word) => title.toLowerCase().includes(word)) ? 1 : 0;
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
  let end = numbers[numbers.length - 1];
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
  const html = await getText("https://farside.co.uk/btc/", "text/html");
  const rows = parseFarside(html);
  if (rows.length < 5) throw new DataError("ETF 资金表没有解析出足够的行");
  return rows;
}

async function yahooEarnings(symbol) {
  const html = await getText(`https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`, "text/html");
  const idx = html.indexOf("earningsDate");
  if (idx < 0) return null;
  const chunk = html.slice(idx, idx + 500);
  const dates = chunk.match(/20\d{2}-\d{2}-\d{2}/g);
  if (!dates) return null;
  const flagAt = chunk.indexOf("isEarningsDateEstimate");
  const flag = flagAt < 0 ? "" : chunk.slice(flagAt, flagAt + 40);
  return { date: dates[0], estimate: flag.includes("true") };
}

async function nasdaqEarnings(symbol) {
  const payload = await getJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=stocks`);
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

export async function fetchEarnings(symbol) {
  let yahoo = null;
  let nasdaq = null;
  try {
    yahoo = await yahooEarnings(symbol);
  } catch (error) {
    if (!(error instanceof DataError)) throw error;
  }
  if (!(yahoo && !yahoo.estimate)) {
    try {
      nasdaq = await nasdaqEarnings(symbol);
    } catch (error) {
      if (!(error instanceof DataError)) throw error;
    }
  }
  let date;
  let estimate;
  if (yahoo && !yahoo.estimate) {
    date = yahoo.date;
    estimate = false;
  } else if (nasdaq) {
    date = nasdaq;
    estimate = false;
  } else if (yahoo) {
    date = yahoo.date;
    estimate = true;
  } else return null;
  const [year, month, day] = date.split("-").map(Number);
  const stamp = nyStamp(year, month, day, 9, 30);
  if (stamp == null) return null;
  return { t: stamp, date, estimate, symbol };
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
  { t: nyStamp(2027, 1, 13, 8, 30), kind: "cpi", impact: "high", title: "美国 CPI", scope: "macro", source: "bls.gov" },
  { t: nyStamp(2027, 1, 27, 14), kind: "fomc", impact: "high", title: "FOMC 利率决议", scope: "macro", source: "federalreserve.gov" },
];

export async function fetchMacroCalendar() {
  const notes = [];
  const collected = FALLBACK_EVENTS.map((event) => ({ ...event }));
  const pages = [
    ["https://www.bls.gov/schedule/news_release/cpi.htm", "cpi", "美国 CPI"],
    ["https://www.bls.gov/schedule/news_release/empsit.htm", "nfp", "美国非农就业"],
    ["https://www.bls.gov/schedule/news_release/ppi.htm", "ppi", "美国 PPI"],
  ];
  await Promise.all(pages.map(async ([url, kind, title]) => {
    try {
      const html = await getText(url, "text/html");
      const parsed = parseBlsReleaseTable(html, kind, title);
      if (parsed.length >= 4) collected.push(...parsed);
      else notes.push(`${title}页面行数不足，保留已核对日期`);
    } catch (error) {
      if (!(error instanceof DataError)) throw error;
      notes.push(`${title}页面暂时取不到，使用已核对日期`);
    }
  }));
  try {
    const html = await getText("https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", "text/html");
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
