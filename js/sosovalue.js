/**
 * Sosovalue 数据融合（清算热力图 / 资金费率 / 交易量 / 新闻侧）
 * Sosovalue 无开放匿名 API；浏览器直连会被 CORS 拦截，这里通过公共代理取 HTML
 * 并尽力解析内嵌 JSON，失败则降级为「不可用」并保留接入钩子。
 */

const PROXIES = [
  (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
];

const SOSO_PAGE = 'https://sosovalue.com/';

async function tryFetchText(url, timeoutMs = 6000) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, ctrl ? { signal: ctrl.signal } : {});
    if (!res.ok) return null;
    return await res.text();
  } catch (_) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pickJsonFromHtml(html) {
  if (!html) return null;
  const markers = ['__NEXT_DATA__', 'liquidation', 'fundingRate', 'openInterest'];
  for (const m of markers) {
    const idx = html.indexOf(m);
    if (idx >= 0) {
      const start = html.lastIndexOf('{', idx);
      const end = html.indexOf('</script>', idx);
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(html.slice(start, end));
        } catch (_) {
          /* continue */
        }
      }
    }
  }
  return null;
}

/** 归一化：尽力从返回结构中提取清算热力图/资金费率/交易量摘要 */
export function normalizeSoso(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = { liquidation: null, fundingRate: null, openInterest: null, volume24h: null, news: [] };
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.liquidation && !out.liquidation) out.liquidation = obj.liquidation;
    if (obj.fundingRate !== undefined && out.fundingRate === null) out.fundingRate = Number(obj.fundingRate);
    if (obj.openInterest !== undefined && out.openInterest === null) out.openInterest = Number(obj.openInterest);
    if (obj.volume24h !== undefined && out.volume24h === null) out.volume24h = Number(obj.volume24h);
    if (Array.isArray(obj.news) && obj.news.length) {
      out.news = obj.news.slice(0, 5).map((n) => (typeof n === 'string' ? n : n.title || '')).filter(Boolean);
    }
    for (const k of Object.keys(obj)) walk(obj[k]);
  };
  walk(raw);
  return out;
}

/**
 * 抓取 Sosovalue 公开页面并尽力提取数据
 * @returns {Promise<object|null>} { liquidation, fundingRate, openInterest, volume24h, news, source }
 */
export async function fetchSosoValue() {
  for (const wrap of PROXIES) {
    const html = await tryFetchText(wrap(SOSO_PAGE));
    if (!html) continue;
    const raw = pickJsonFromHtml(html);
    const norm = normalizeSoso(raw);
    if (norm && (norm.liquidation || norm.fundingRate !== null || norm.volume24h !== null)) {
      return { ...norm, source: 'sosovalue' };
    }
  }
  return null;
}

/** 把 Sosovalue 结果转成报告可读文本 */
export function describeSoso(data) {
  if (!data) return 'Sosovalue 数据暂不可用（需付费 API 或代理）；已接入钩子。';
  const parts = [];
  if (data.liquidation) parts.push(`清算热力图：${JSON.stringify(data.liquidation).slice(0, 120)}`);
  if (data.fundingRate !== null) parts.push(`资金费率 ${(data.fundingRate * 100).toFixed(4)}%`);
  if (data.openInterest !== null) parts.push(`未平仓量 ${data.openInterest}`);
  if (data.volume24h !== null) parts.push(`24h 交易量 ${data.volume24h}`);
  if (data.news && data.news.length) parts.push(`要闻：${data.news.join(' | ')}`);
  return parts.length ? parts.join('；') : 'Sosovalue 返回但无可解析字段。';
}
