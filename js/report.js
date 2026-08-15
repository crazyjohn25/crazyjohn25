/**
 * 分析报告模块
 * 每日 23:00（UTC+8）自动生成基本面日报：用 30m/1h/4h/日线多周期数据，
 * 叠加宏观新闻面、Sosovalue 清算/资金/交易量、策略1（体制/位置/确认/执行）与策略2（指标分组）。
 * 打开页面不再自动生成报告，只展示已有存档；日报由定时任务在 23:00 生成并推送。
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
    this.key = opts.key || 'kchart.reports.v2';
    this.max = opts.max || 60;
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

  /** 最近一条日报 */
  latestDaily() {
    return this.reports.filter((r) => r.type === 'daily-report').slice(-1)[0] || null;
  }
}

/**
 * 生成每日基本面日报（纯函数）
 * @param {Object} p {
 *   dateLabel, symbol, symbolLabel, price,
 *   perTf: { '30m': analyzeTimeframe, '1h': ..., '4h': ..., '1d': ... },
 *   strategy1: strategyOne 输出,
 *   strategy2: strategyTwo 输出,
 *   soso: fetchSosoValue 输出,
 *   newsBias, topNews, reflections
 * }
 */
export function generateDailyReport(p) {
  const sections = [];
  const { perTf, strategy1, strategy2, soso, newsBias, topNews } = p;

  // 1) 多周期基本面（30m/1h/4h/日线）
  const tfLines = [];
  for (const tf of ['30m', '1h', '4h', '1d']) {
    const r = perTf && perTf[tf];
    if (!r || r.verdict === '数据不足') continue;
    const m = r.meta || {};
    tfLines.push(
      `${tf}: ${r.verdict}（${r.score.toFixed(1)}分）` +
        (m.rsi !== null && m.rsi !== undefined ? ` RSI=${m.rsi.toFixed(0)}` : '') +
        (m.atr ? ` ATR=${m.atr.toFixed(1)}` : '') +
        (m.vwap ? ` VWAP=${m.vwap.toFixed(1)}` : '') +
        (m.support !== null && m.support ? ` 支撑${m.support.toFixed(1)}` : '') +
        (m.resistance !== null && m.resistance ? ` 阻力${m.resistance.toFixed(1)}` : '')
    );
  }
  sections.push({ title: '多周期形势（30m/1h/4h/日线）', lines: tfLines });

  // 2) Sosovalue 融合（清算热力图/资金费率/交易量/新闻侧）
  sections.push({
    title: 'Sosovalue 数据（清算热力图/资金/交易量/新闻侧）',
    lines: [soso ? describeSosoText(soso) : 'Sosovalue 暂不可用（需付费 API 或代理），已用本地清算簇/资金费率钩子替代'],
  });

  // 3) 策略1：体制→位置→确认→执行
  if (strategy1) {
    sections.push({ title: `策略1（体制/位置/确认/执行）— ${strategy1.verdict}（${strategy1.totalScore}）`, lines: flattenSections(strategy1.sections) });
  }

  // 4) 策略2：EMA/MACD/RSI/SUPER/SAR/KDJ/OBV/DMI 分组
  if (strategy2) {
    sections.push({ title: `策略2（趋势/动量/震荡/量能分组）— ${strategy2.verdict}（${strategy2.totalScore}）`, lines: flattenSections(strategy2.sections) });
  }

  // 5) 新闻面与要闻
  if (newsBias) {
    sections.push({ title: '新闻面（24小时）', lines: [newsBias.reason] });
  }
  if (topNews && topNews.length) {
    sections.push({ title: '今日要闻', lines: topNews.slice(0, 5).map((n) => n.title) });
  }

  // 6) 反思与明日关注
  const refl = [];
  if (p.reflections && p.reflections.length) refl.push(...p.reflections);
  if (strategy1 && strategy2) {
    if (strategy1.verdict !== strategy2.verdict) refl.push(`策略1（${strategy1.verdict}）与策略2（${strategy2.verdict}）分歧，明日降低仓位或等待共振`);
    else refl.push(`策略1与策略2同为${strategy1.verdict}，明日可延续该方向观察`);
  }
  if (refl.length) sections.push({ title: '反思与明日关注', lines: refl });

  const summary = [
    `【${p.symbolLabel}】${strategy1 ? strategy1.verdict : '无策略1'} / ${strategy2 ? strategy2.verdict : '无策略2'}`,
    `日线 ${perTf['1d']?.verdict || '-'}，4h ${perTf['4h']?.verdict || '-'}，1h ${perTf['1h']?.verdict || '-'}，30m ${perTf['30m']?.verdict || '-'}`,
  ].join('；');

  return {
    time: Math.floor(Date.now() / 1000),
    type: 'daily-report',
    dateLabel: p.dateLabel,
    symbol: p.symbol,
    symbolLabel: p.symbolLabel,
    price: p.price,
    sections,
    summary,
  };
}

function flattenSections(sections) {
  return (sections || []).flatMap((s) => [`【${s.title}】`, ...(s.lines || [])]);
}

function describeSosoText(soso) {
  const parts = [];
  if (soso.liquidation) parts.push(`清算热力图：${JSON.stringify(soso.liquidation).slice(0, 120)}`);
  if (soso.fundingRate !== null && soso.fundingRate !== undefined) parts.push(`资金费率 ${(soso.fundingRate * 100).toFixed(4)}%`);
  if (soso.openInterest !== null && soso.openInterest !== undefined) parts.push(`未平仓量 ${soso.openInterest}`);
  if (soso.volume24h !== null && soso.volume24h !== undefined) parts.push(`24h 交易量 ${soso.volume24h}`);
  if (soso.news && soso.news.length) parts.push(`要闻：${soso.news.join(' | ')}`);
  return parts.length ? parts.join('；') : 'Sosovalue 返回但无可解析字段。';
}

/** 生成旧版即时报告（兼容少量调用；不再自动存档，只用于「立即重新分析」按钮临时预览） */
export function generateReport(p) {
  const { strategies, perTf, gamma, newsBias } = p;
  const sections = [];
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
  if (newsBias) {
    sections.push({ title: '新闻面（24小时）', lines: [newsBias.reason] });
  }
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
