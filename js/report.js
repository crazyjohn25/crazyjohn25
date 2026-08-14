/**
 * 资产分析报告模块
 * 每次建议刷新时生成结构化分析报告（技术面全指标 + Gamma环境 + 新闻面 + KOL观点），
 * 存档到 localStorage 供每日复盘；每天 10:00 与 23:00（UTC+8）生成两次日度复盘报告。
 */

const memoryStore = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
  };
};

export class ReportArchive {
  constructor(opts = {}) {
    this.storage =
      opts.storage || (typeof localStorage !== 'undefined' ? localStorage : memoryStore());
    this.key = opts.key || 'kchart.reports.v1';
    this.max = opts.max || 150;
    this.reports = this._load();
  }

  _load() {
    try {
      const raw = this.storage.getItem(this.key);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  _save() {
    if (this.reports.length > this.max) this.reports = this.reports.slice(-this.max);
    this.storage.setItem(this.key, JSON.stringify(this.reports));
  }

  add(report) {
    this.reports.push(report);
    this._save();
    return report;
  }

  /** 最近n条（新在前） */
  recent(n = 20) {
    return this.reports.slice(-n).reverse();
  }

  /** 某日（UTC+8）的报告 */
  ofDay(dayStartSecUtc8) {
    return this.reports.filter((r) => {
      const d = Math.floor((r.time + 8 * 3600) / 86400);
      return d === dayStartSecUtc8;
    });
  }
}

/**
 * 生成结构化分析报告（纯函数）
 * @param {Object} p { symbol, symbolLabel, price, strategies, perTf, gamma, gammaText, newsBias, newsCount, kolSignals }
 */
export function generateReport(p) {
  const { strategies, perTf, gamma, newsBias } = p;
  const sections = [];

  // 技术面摘要
  const tech = [];
  for (const tf of ['1h', '4h', '1d']) {
    const r = perTf && perTf[tf];
    if (!r || r.verdict === '数据不足') continue;
    const m = r.meta || {};
    tech.push(
      `${tf}: ${r.verdict}（${r.score.toFixed(1)}分）` +
        (m.rsi !== null && m.rsi !== undefined ? ` RSI=${m.rsi.toFixed(0)}` : '') +
        (m.atr ? ` ATR=${m.atr.toFixed(1)}` : '') +
        (m.vwap ? ` VWAP=${m.vwap.toFixed(1)}` : '') +
        (m.support !== null && m.support ? ` 支撑${m.support.toFixed(1)}` : '') +
        (m.resistance !== null && m.resistance ? ` 阻力${m.resistance.toFixed(1)}` : '')
    );
  }
  sections.push({ title: '技术面（MACD/BOLL/RSI/KDJ/STOCH/WAE/DMI/OBV/均线彩带）', lines: tech });

  // Gamma环境
  if (gamma) {
    sections.push({
      title: '做市商Gamma环境（Deribit期权）',
      lines: [
        `${gamma.regime === 'positive' ? '正Gamma（震荡市，做市商平抑波动）' : '负Gamma（趋势市，做市商放大波动）'} · GEX≈$${(gamma.gex / 1e6).toFixed(1)}M/1%`,
        gamma.callWall ? `Call Wall ${gamma.callWall.strike}（上方压力/磁吸）` : '',
        gamma.putWall ? `Put Wall ${gamma.putWall.strike}（下方支撑）` : '',
      ].filter(Boolean),
    });
  }

  // 新闻面
  if (newsBias) {
    sections.push({ title: '新闻面（24小时）', lines: [newsBias.reason] });
  }

  // 策略结论
  const concl = (strategies || [])
    .map((s) => `${s.label}：${s.action}（评分${s.score.toFixed(1)}，置信度${(s.conf * 100).toFixed(0)}%）`)
    .join('；');
  sections.push({ title: '策略结论', lines: [concl || '无'] });

  return {
    time: Math.floor(Date.now() / 1000),
    symbol: p.symbol,
    symbolLabel: p.symbolLabel,
    price: p.price,
    sections,
    summary: concl,
  };
}

/**
 * 生成日度复盘报告（纯函数）
 * @param {Object} p { dateLabel, reports, walletStats, closedToday, topNews, reflections }
 */
export function generateDailyReview(p) {
  const lines = [];
  lines.push(`今日产出分析报告 ${p.reports.length} 份`);
  if (p.closedToday && p.closedToday.length) {
    const wins = p.closedToday.filter((t) => t.netPnl > 0).length;
    const pnl = p.closedToday.reduce((s, t) => s + t.netPnl, 0);
    lines.push(
      `今日平仓 ${p.closedToday.length} 笔：胜 ${wins} / 负 ${p.closedToday.length - wins}，净盈亏 ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(1)}`
    );
  } else {
    lines.push('今日无平仓（无符合风控的机会或持仓未到期）');
  }
  if (p.walletStats) {
    lines.push(
      `钱包累计：${p.walletStats.spotTrades}笔，胜率${p.walletStats.spotWinRate !== null ? (p.walletStats.spotWinRate * 100).toFixed(0) + '%' : '-'}，净盈亏 ${p.walletStats.spotNetPnl >= 0 ? '+' : ''}$${p.walletStats.spotNetPnl.toFixed(1)}，累计手续费 $${p.walletStats.totalFees.toFixed(1)}`
    );
  }
  if (p.topNews && p.topNews.length) {
    lines.push('今日要闻：' + p.topNews.slice(0, 3).map((n) => n.title).join(' | '));
  }
  if (p.reflections && p.reflections.length) {
    lines.push('反思：' + p.reflections.join('；'));
  }
  return {
    time: Math.floor(Date.now() / 1000),
    type: 'daily-review',
    dateLabel: p.dateLabel,
    lines,
  };
}
