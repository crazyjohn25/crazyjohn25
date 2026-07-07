/**
 * 建议复盘与反思模块
 * 1. 每次给出建议（综合建议 / Polymarket 5m方向）时登记预测：方向、当时价格、评估时点；
 * 2. 到达评估时点后，用实际价格判定命中与否；
 * 3. 统计各来源/各周期滚动命中率，命中率低的来源自动降权（写回建议引擎权重），
 *    并在面板中给出反思说明，避免重复给出同类错误建议。
 *
 * 纯逻辑与存储分离：ReviewLog 可注入自定义storage便于测试。
 */

const memoryStore = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
  };
};

export class ReviewLog {
  /**
   * @param {Object} opts { storage, key, maxRecords }
   */
  constructor(opts = {}) {
    this.storage =
      opts.storage || (typeof localStorage !== 'undefined' ? localStorage : memoryStore());
    this.key = opts.key || 'kchart.reviewLog.v1';
    this.maxRecords = opts.maxRecords || 300;
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
   * 登记一条预测
   * @param {Object} r { source, symbol, direction('up'|'down'|'flat'), priceAtCall, callTime, evalTime, note }
   */
  record(r) {
    // 同一来源在同一评估时点只记一次，避免30分钟内重复登记
    const dup = this.records.find(
      (x) => x.source === r.source && x.symbol === r.symbol && x.evalTime === r.evalTime
    );
    if (dup) return null;
    const rec = { ...r, id: `${r.source}_${r.evalTime}_${Math.random().toString(36).slice(2, 6)}`, outcome: null };
    this.records.push(rec);
    this._save();
    return rec;
  }

  /**
   * 用最新价格结算已到期的预测
   * @param {Function} priceAt (symbol, timeSec) => number|null 取评估时点价格
   * @param {number} nowSec
   * @returns {Array} 本次新结算的记录
   */
  settle(priceAt, nowSec = Math.floor(Date.now() / 1000)) {
    const settled = [];
    for (const r of this.records) {
      if (r.outcome !== null || r.evalTime > nowSec) continue;
      const p = priceAt(r.symbol, r.evalTime);
      if (p === null || p === undefined) continue;
      const chg = (p - r.priceAtCall) / r.priceAtCall;
      let hit;
      if (r.direction === 'flat') {
        hit = Math.abs(chg) < 0.002; // 观望：小幅波动算"正确地没参与"
      } else {
        hit = r.direction === 'up' ? chg > 0 : chg < 0;
      }
      r.outcome = hit ? 'hit' : 'miss';
      r.evalPrice = p;
      r.changePct = chg * 100;
      settled.push(r);
    }
    if (settled.length) this._save();
    return settled;
  }

  /** 各来源滚动命中率统计 */
  stats(windowSize = 20) {
    const bySource = {};
    for (const r of this.records) {
      if (r.outcome === null || r.direction === 'flat') continue;
      if (!bySource[r.source]) bySource[r.source] = [];
      bySource[r.source].push(r);
    }
    const out = {};
    for (const [src, arr] of Object.entries(bySource)) {
      const recent = arr.slice(-windowSize);
      const hits = recent.filter((r) => r.outcome === 'hit').length;
      out[src] = {
        total: recent.length,
        hits,
        hitRate: recent.length > 0 ? hits / recent.length : null,
      };
    }
    return out;
  }

  /** 最近N条已结算记录（新在前） */
  recent(n = 10) {
    return this.records
      .filter((r) => r.outcome !== null)
      .slice(-n)
      .reverse();
  }

  /** 未结算的预测数 */
  pendingCount() {
    return this.records.filter((r) => r.outcome === null).length;
  }
}

/**
 * 根据滚动命中率生成自适应权重与反思文字（纯函数）
 * 命中率<45%的周期降权，<35%减半；>60%小幅加权。
 * @param {Object} stats ReviewLog.stats() 输出，key形如 'advisor:15m'
 * @param {Object} baseWeights 基础权重 { '15m':1, ... }
 * @returns {{ weights, reflections: string[] }}
 */
export function adaptWeights(stats, baseWeights) {
  const weights = { ...baseWeights };
  const reflections = [];
  for (const [tf, base] of Object.entries(baseWeights)) {
    const s = stats[`advisor:${tf}`];
    if (!s || s.total < 5) continue; // 样本太少不调整
    const pct = (s.hitRate * 100).toFixed(0);
    if (s.hitRate < 0.35) {
      weights[tf] = base * 0.5;
      reflections.push(
        `${tf}周期近${s.total}次建议命中率仅${pct}%，已减半其权重；该周期近期噪音大，避免用它主导方向判断`
      );
    } else if (s.hitRate < 0.45) {
      weights[tf] = base * 0.75;
      reflections.push(`${tf}周期近${s.total}次命中率${pct}%偏低，已降权25%`);
    } else if (s.hitRate > 0.6) {
      weights[tf] = base * 1.2;
      reflections.push(`${tf}周期近${s.total}次命中率${pct}%表现好，小幅加权`);
    }
  }
  const pm = stats['polymarket:5m'];
  if (pm && pm.total >= 5 && pm.hitRate < 0.45) {
    reflections.push(
      `Polymarket 5m方向建议近${pm.total}次命中率${(pm.hitRate * 100).toFixed(0)}%，低于盈亏平衡，建议只在期望差值>10分时参与`
    );
  }
  return { weights, reflections };
}
