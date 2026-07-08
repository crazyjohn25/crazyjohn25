/**
 * Polymarket 5分钟预测：历史记录、深度统计与错误反思
 * 每期窗口在给出建议时登记快照（含当时全部推理依据），窗口结束后自动结算，
 * 并对错误进行归因分类，生成可执行的反思结论。
 */

const memoryStore = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
  };
};

export class PmHistory {
  constructor(opts = {}) {
    this.storage =
      opts.storage || (typeof localStorage !== 'undefined' ? localStorage : memoryStore());
    this.key = opts.key || 'kchart.pmHistory.v1';
    this.maxRecords = opts.maxRecords || 200;
    this.records = this._load();
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
    if (this.records.length > this.maxRecords)
      this.records = this.records.slice(-this.maxRecords);
    this.storage.setItem(this.key, JSON.stringify(this.records));
  }

  /**
   * 登记一期预测快照（每窗口一条，重复登记会更新为最新快照）
   * @param {Object} r { winStart, winEnd, action, edge, techProb, strike,
   *                     priceAtCall, secondsLeftAtCall, leadPct, flowBias, bookImbalance,
   *                     upPrice, reasons[] }
   */
  record(r) {
    const idx = this.records.findIndex((x) => x.winStart === r.winStart);
    const rec = { ...r, outcome: null, hit: null, missCause: null };
    const isCall = (a) => a === '买Up' || a === '买Down';
    if (idx >= 0) {
      const old = this.records[idx];
      if (old.outcome !== null) return old; // 已结算不再改
      // 首次出现的方向建议是可交易时点，之后的"勿追单/观望"不覆盖它
      if (isCall(old.action) && !isCall(r.action)) return old;
      this.records[idx] = rec;
    } else {
      this.records.push(rec);
    }
    this._save();
    return rec;
  }

  /**
   * 结算到期窗口
   * @param {Function} priceAt (timeSec) => number|null 取BTC某时刻价格
   * @param {number} nowSec
   * @returns 本次新结算的记录
   */
  settle(priceAt, nowSec = Math.floor(Date.now() / 1000)) {
    const settled = [];
    for (const r of this.records) {
      if (r.outcome !== null || r.winEnd > nowSec) continue;
      const endPrice = priceAt(r.winEnd);
      if (endPrice === null || endPrice === undefined || !r.strike) continue;
      r.endPrice = endPrice;
      r.outcome = endPrice >= r.strike ? 'up' : 'down';
      if (r.action === '买Up' || r.action === '买Down') {
        const predicted = r.action === '买Up' ? 'up' : 'down';
        r.hit = predicted === r.outcome;
        if (!r.hit) r.missCause = classifyMiss(r);
      }
      settled.push(r);
    }
    if (settled.length) this._save();
    return settled;
  }

  /** 已结算且有方向的记录（新在前），供历史回滚查看 */
  settledCalls(n = 30) {
    return this.records
      .filter((r) => r.hit !== null)
      .slice(-n)
      .reverse();
  }

  pendingCount() {
    return this.records.filter((r) => r.outcome === null).length;
  }
}

/** 错误归因分类（纯函数） */
export function classifyMiss(r) {
  const lead = Math.abs(r.leadPct ?? 0);
  if (lead < 0.02) {
    return {
      code: 'thin_lead',
      label: '领先优势过薄',
      detail: `下单时价格仅偏离目标价${lead.toFixed(3)}%，在5分钟噪音范围内，本质是掷硬币`,
    };
  }
  if (r.secondsLeftAtCall > 180) {
    return {
      code: 'too_early',
      label: '入场过早遭反转',
      detail: `下单时剩余${r.secondsLeftAtCall}秒，时间越长反转概率越高，领先优势被时间稀释`,
    };
  }
  if (r.flowBias !== undefined && r.flowBias !== null) {
    const flowDir = r.flowBias > 0 ? 'up' : 'down';
    const predicted = r.action === '买Up' ? 'up' : 'down';
    if (flowDir === predicted) {
      return {
        code: 'flow_trap',
        label: '资金流误导',
        detail: 'Polymarket押注资金流与预测同向但结果相反——群体押注方向不代表现货走向，资金流权重应降低',
      };
    }
  }
  return {
    code: 'reversal',
    label: '尾盘反转',
    detail: '价格在窗口最后阶段穿越目标价，5分钟级别的现货瞬时波动无法被指标预测',
  };
}

/**
 * 深度统计（纯函数）
 * @param {Array} records PmHistory.records
 */
export function pmDeepStats(records) {
  const calls = records.filter((r) => r.hit !== null);
  if (calls.length === 0) return null;

  const hits = calls.filter((r) => r.hit);
  const byBucket = (fn) => {
    const buckets = {};
    for (const r of calls) {
      const k = fn(r);
      if (!buckets[k]) buckets[k] = { total: 0, hits: 0 };
      buckets[k].total++;
      if (r.hit) buckets[k].hits++;
    }
    return buckets;
  };

  const edgeBuckets = byBucket((r) =>
    Math.abs(r.edge) >= 0.15 ? 'edge≥15分' : Math.abs(r.edge) >= 0.1 ? 'edge 10-15分' : 'edge 8-10分'
  );
  const timeBuckets = byBucket((r) =>
    r.secondsLeftAtCall > 180 ? '剩余>3分钟' : r.secondsLeftAtCall > 90 ? '剩余1.5-3分钟' : '剩余<1.5分钟'
  );
  const missCauses = {};
  for (const r of calls) {
    if (r.hit || !r.missCause) continue;
    const k = r.missCause.label;
    missCauses[k] = (missCauses[k] || 0) + 1;
  }

  const avg = (arr, f) => (arr.length ? arr.reduce((s, x) => s + f(x), 0) / arr.length : null);

  return {
    total: calls.length,
    hits: hits.length,
    hitRate: hits.length / calls.length,
    avgEdgeHit: avg(hits, (r) => Math.abs(r.edge)),
    avgEdgeMiss: avg(calls.filter((r) => !r.hit), (r) => Math.abs(r.edge)),
    edgeBuckets,
    timeBuckets,
    missCauses,
    // 理论盈亏：按1单位计，买价=隐含概率，赢得1
    pnl: calls.reduce((s, r) => {
      const cost = r.action === '买Up' ? r.upPrice : 1 - r.upPrice;
      if (cost === null || cost === undefined) return s;
      return s + (r.hit ? 1 - cost : -cost);
    }, 0),
  };
}

/**
 * 反思结论生成（纯函数）：找出系统性弱点并输出改进规则
 */
export function pmReflections(stats) {
  if (!stats || stats.total < 5) return ['样本不足（<5次），继续积累数据后再做归因'];
  const out = [];
  const pct = (x) => (x * 100).toFixed(0) + '%';

  out.push(
    `累计${stats.total}次方向预测，命中${stats.hits}次（${pct(stats.hitRate)}），理论盈亏${stats.pnl >= 0 ? '+' : ''}${stats.pnl.toFixed(2)}单位`
  );

  for (const [k, b] of Object.entries(stats.timeBuckets)) {
    if (b.total >= 3 && b.hits / b.total < 0.45) {
      out.push(`【${k}】时段命中率仅${pct(b.hits / b.total)}（${b.hits}/${b.total}）：该时段入场胜率低，应回避或要求更高edge`);
    }
  }
  for (const [k, b] of Object.entries(stats.edgeBuckets)) {
    if (b.total >= 3 && b.hits / b.total < 0.45) {
      out.push(`【${k}】区间命中率${pct(b.hits / b.total)}偏低：edge估计在该区间不可靠，考虑提高最低edge门槛`);
    }
  }
  const topMiss = Object.entries(stats.missCauses).sort((a, b) => b[1] - a[1])[0];
  if (topMiss && topMiss[1] >= 2) {
    out.push(`最常见错误是【${topMiss[0]}】（${topMiss[1]}次）——针对性修正规则已写入建议引擎的下一次评估`);
  }
  if (stats.avgEdgeHit !== null && stats.avgEdgeMiss !== null && stats.avgEdgeMiss >= stats.avgEdgeHit) {
    out.push('命中单与错误单的平均edge无显著差异，说明当前edge测算对短线噪音过度自信，已建议仅参与edge≥12分且剩余<3分钟的窗口');
  }
  return out;
}
