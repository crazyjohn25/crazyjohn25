/**
 * 强烈信号存档
 * 只收录 |评分| ≥ MAJOR_THRESHOLD 的共振信号；同一品种+策略+方向在去重窗口内
 * 不重复入库（评分未明显增强则视为噪音），避免侧栏和提醒被弱信号刷屏。
 */
import { MAJOR_THRESHOLD } from './advisor.js';

const memoryStore = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
  };
};

/** 同一指纹（品种+策略+方向）12小时内不重复播报 */
export const SIGNAL_DEDUP_SEC = 12 * 3600;
/** 评分需至少高出上次 0.5 才视为「增强」并再存一条 */
export const SCORE_UPGRADE = 0.5;

export function signalFingerprint({ symbol, strategy, side }) {
  return `${symbol}|${strategy}|${side}`;
}

export class SignalArchive {
  constructor(opts = {}) {
    this.storage =
      opts.storage || (typeof localStorage !== 'undefined' ? localStorage : memoryStore());
    this.key = opts.key || 'kchart.signals.v1';
    this.max = opts.max || 80;
    this.dedupSec = opts.dedupSec || SIGNAL_DEDUP_SEC;
    this.threshold = opts.threshold || MAJOR_THRESHOLD;
    this.items = this._load();
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
    if (this.items.length > this.max) this.items = this.items.slice(-this.max);
    this.storage.setItem(this.key, JSON.stringify(this.items));
  }

  /**
   * 尝试存档一条强烈信号。弱信号或窗口内重复返回 null。
   * @returns {object|null} 新存档记录
   */
  consider(sig) {
    if (!sig) return null;
    const score = Number(sig.score);
    if (!Number.isFinite(score) || Math.abs(score) < this.threshold) return null;
    const side = sig.side || (score > 0 ? 'long' : 'short');
    const fp = signalFingerprint({ symbol: sig.symbol, strategy: sig.strategy, side });
    const now = sig.time || Math.floor(Date.now() / 1000);
    const prev = [...this.items].reverse().find((x) => x.fingerprint === fp);
    if (prev && now - prev.time < this.dedupSec && Math.abs(score) <= Math.abs(prev.score) + SCORE_UPGRADE - 1e-9) {
      return null;
    }
    const rec = {
      id: `sg${now}_${Math.random().toString(36).slice(2, 6)}`,
      fingerprint: fp,
      symbol: sig.symbol,
      strategy: sig.strategy,
      side,
      score,
      action: sig.action || '',
      label: sig.label || sig.strategy,
      price: sig.price ?? null,
      plan: sig.plan || null,
      reasons: Array.isArray(sig.reasons) ? sig.reasons.slice(0, 6) : [],
      time: now,
    };
    this.items.push(rec);
    this._save();
    return rec;
  }

  /** 最近 n 条（新在前） */
  recent(n = 20) {
    return this.items.slice(-n).reverse();
  }
}
