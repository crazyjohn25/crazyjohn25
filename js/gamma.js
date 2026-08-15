/**
 * 做市商 Gamma 敞口模块（Deribit 公开API，仅 BTC/ETH 有期权数据）
 * 用 book_summary 的 mark_iv + open_interest + underlying_price，
 * 以 Black-Scholes 公式计算每个期权的 Gamma，聚合出做市商净 Gamma 敞口（GEX）。
 *
 * 约定（业界常用近似）：做市商通常卖出看跌/买入看涨方向对冲，
 * GEX = Σ(看涨 gamma×OI) − Σ(看跌 gamma×OI)，单位换算为"标的价格每变动1%的美元Gamma"。
 * GEX>0（正Gamma）：做市商低买高卖平抑波动 → 行情倾向区间震荡；
 * GEX<0（负Gamma）：做市商追涨杀跌放大波动 → 趋势与急涨急跌概率上升。
 */

const DERIBIT = 'https://www.deribit.com/api/v2/public';

/** 标准正态密度 */
function phi(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Black-Scholes Gamma
 * @param {number} S 标的价格
 * @param {number} K 行权价
 * @param {number} tYears 到期时间（年）
 * @param {number} ivPct 隐含波动率（%）
 */
export function bsGamma(S, K, tYears, ivPct) {
  if (S <= 0 || K <= 0 || tYears <= 0 || ivPct <= 0) return 0;
  const vol = ivPct / 100;
  const d1 = (Math.log(S / K) + (vol * vol) / 2 * tYears) / (vol * Math.sqrt(tYears));
  return phi(d1) / (S * vol * Math.sqrt(tYears));
}

/** 解析 Deribit 合约名：BTC-25JUN27-68000-P */
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
export function parseInstrument(name) {
  const m = /^([A-Z]+)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-([CP])$/.exec(name || '');
  if (!m) return null;
  const [, , d, mon, yy, strike, cp] = m;
  const expiry = Date.UTC(2000 + Number(yy), MONTHS[mon], Number(d), 8, 0, 0) / 1000; // Deribit 8:00 UTC 到期
  return { strike: Number(strike), isCall: cp === 'C', expiry };
}

/**
 * 从 book_summary 数组计算 GEX 结构（纯函数，可测）
 * @returns {{ gex, regime, callWall, putWall, spot, totalOi } | null}
 */
export function computeGex(rows, nowSec = Math.floor(Date.now() / 1000)) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const spot = rows[0].underlying_price;
  if (!spot) return null;

  let gex = 0;
  let totalOi = 0;
  const strikeGamma = new Map(); // strike -> { call, put }

  for (const r of rows) {
    const info = parseInstrument(r.instrument_name);
    if (!info || !r.open_interest || !r.mark_iv) continue;
    const t = (info.expiry - nowSec) / (365.25 * 86400);
    if (t <= 0.002) continue; // 忽略即将到期（gamma爆炸失真）
    const g = bsGamma(spot, info.strike, t, r.mark_iv);
    // 美元Gamma：gamma × OI(张) × S² × 1%（Deribit BTC期权1张=1BTC）
    const dollarGamma = g * r.open_interest * spot * spot * 0.01;
    totalOi += r.open_interest;
    const sign = info.isCall ? 1 : -1;
    gex += sign * dollarGamma;
    const sg = strikeGamma.get(info.strike) || { call: 0, put: 0 };
    if (info.isCall) sg.call += dollarGamma;
    else sg.put += dollarGamma;
    strikeGamma.set(info.strike, sg);
  }

  if (totalOi === 0) return null;

  let callWall = null;
  let putWall = null;
  for (const [strike, v] of strikeGamma) {
    if (callWall === null || v.call > callWall.gamma) callWall = { strike, gamma: v.call };
    if (putWall === null || v.put > putWall.gamma) putWall = { strike, gamma: v.put };
  }

  return {
    gex,
    regime: gex >= 0 ? 'positive' : 'negative',
    callWall,
    putWall,
    spot,
    totalOi,
  };
}

/** 拉取并计算 BTC 或 ETH 的 GEX */
export async function fetchGex(currency = 'BTC') {
  try {
    const res = await fetch(
      `${DERIBIT}/get_book_summary_by_currency?currency=${currency}&kind=option`,
      { signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return computeGex(data.result || []);
  } catch (_) {
    return null;
  }
}

/** GEX 解读文案 */
export function explainGex(g) {
  if (!g) return '期权数据不可用（仅BTC/ETH支持）';
  const lines = [];
  if (g.regime === 'positive') {
    lines.push(
      `当前为正Gamma环境（GEX≈$${(g.gex / 1e6).toFixed(1)}M/1%）：做市商低买高卖平抑波动，行情倾向区间震荡，追涨杀跌胜率低，适合高抛低吸与均值回归。`
    );
  } else {
    lines.push(
      `当前为负Gamma环境（GEX≈-$${(Math.abs(g.gex) / 1e6).toFixed(1)}M/1%）：做市商被迫追涨杀跌放大波动，趋势行情与急涨急跌概率上升，突破跟随策略优于逆势抄底，务必收紧止损。`
    );
  }
  if (g.callWall) lines.push(`看涨墙（Call Wall）：${g.callWall.strike}——上方磁吸/压力区`);
  if (g.putWall) lines.push(`看跌墙（Put Wall）：${g.putWall.strike}——下方支撑区`);
  return lines.join('\n');
}
