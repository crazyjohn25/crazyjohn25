/**
 * 模拟交易钱包（Paper Trading，v3）
 * - 合约钱包：初始资金可在后台设置（默认$10000），单笔保证金$500-1000，杠杆20-100x，
 *   币安标准费率：taker 0.05%/边（开平双边计），资金费率 0.01%/8小时（按名义价值），
 *   亏损达保证金95%触发强平（损失全部保证金，含平仓费）。
 * - 支持手动平仓、注资、出金、设置初始资金。
 * - 每日收益复盘：只统计有真实平仓的日期（无开仓不记录）。
 * 核心风控：最多3个并存仓位、同品种同策略6小时冷却、只做高置信信号、每天至少一单（有合格信号时）。
 */

export const FEE_RATE = 0.0005; // taker 0.05%/边（币安USDT永续普通用户）
export const FUNDING_RATE = 0.0001; // 资金费率 0.01%/8h（币安常规基准）
export const FUNDING_INTERVAL = 8 * 3600;
export const MARGIN_MIN = 500;
export const MARGIN_MAX = 1000;
export const LEV_MIN = 20;
export const LEV_MAX = 100;
const LIQ_THRESHOLD = 0.95;

const memoryStore = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
  };
};

export class PaperWallet {
  constructor(opts = {}) {
    this.storage =
      opts.storage || (typeof localStorage !== 'undefined' ? localStorage : memoryStore());
    this.key = opts.key || 'kchart.paperWallet.v3';
    this.maxOpen = opts.maxOpen || 3;
    this.cooldownSec = opts.cooldownSec || 6 * 3600;
    const initial = opts.initialCapital ?? 10000;
    const s = this._load();
    this.cash = s.cash ?? initial;
    this.positions = s.positions || [];
    this.closed = s.closed || [];
    this.equity = s.equity || [];
    this.lastEntry = s.lastEntry || {};
    this.baseCapital = s.baseCapital ?? initial;
    this.createdAt = s.createdAt || Math.floor(Date.now() / 1000);
  }

  _load() {
    try {
      const raw = this.storage.getItem(this.key);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  _save() {
    if (this.closed.length > 300) this.closed = this.closed.slice(-300);
    if (this.equity.length > 1000) this.equity = this.equity.slice(-1000);
    this.storage.setItem(
      this.key,
      JSON.stringify({
        cash: this.cash,
        positions: this.positions,
        closed: this.closed,
        equity: this.equity,
        lastEntry: this.lastEntry,
        baseCapital: this.baseCapital,
        createdAt: this.createdAt,
      })
    );
  }

  /** 设置初始资金（清空重来） */
  setInitialCapital(amount) {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 100 || amt > 10000000) return false;
    this.cash = amt;
    this.baseCapital = amt;
    this.positions = [];
    this.closed = [];
    this.equity = [];
    this.lastEntry = {};
    this.createdAt = Math.floor(Date.now() / 1000);
    this._save();
    return true;
  }

  /** 注资 */
  addFunds(amount) {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > 10000000) return false;
    this.cash += amt;
    this.baseCapital += amt;
    this._save();
    return true;
  }

  /** 出金（不能超过可用现金） */
  withdrawFunds(amount) {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > this.cash) return false;
    this.cash -= amt;
    this.baseCapital -= amt;
    this._save();
    return true;
  }

  // ---------------- 合约 ----------------

  openPosition({ symbol, side, price, margin, leverage, stop, target, reason, time, strategy }) {
    margin = Math.max(MARGIN_MIN, Math.min(MARGIN_MAX, margin || MARGIN_MIN));
    leverage = Math.max(LEV_MIN, Math.min(LEV_MAX, leverage || LEV_MIN));
    const k = `${symbol}|${strategy}`;

    if (this.positions.length >= this.maxOpen) return { rejected: `已达最大并存仓位${this.maxOpen}个` };
    if (this.positions.some((p) => p.symbol === symbol && p.strategy === strategy))
      return { rejected: '同品种同策略已有持仓' };
    if (this.lastEntry[k] && time - this.lastEntry[k] < this.cooldownSec)
      return { rejected: '同键6小时冷却中，避免频繁交易' };
    const notional = margin * leverage;
    const fee = notional * FEE_RATE;
    if (this.cash < margin + fee) return { rejected: '钱包余额不足' };

    this.cash -= margin + fee;
    const pos = {
      id: `p${time}_${Math.random().toString(36).slice(2, 6)}`,
      symbol, side, entry: price, margin, leverage, notional,
      stop: stop ?? null, target: target ?? null,
      openFee: fee, fundingPaid: 0, lastFundingTime: time,
      reason: reason || '', strategy: strategy || '-',
      openTime: time, lastPrice: price,
    };
    this.positions.push(pos);
    this.lastEntry[k] = time;
    this._save();
    return pos;
  }

  unrealized(pos, price) {
    const chg = (price - pos.entry) / pos.entry;
    return pos.notional * chg * (pos.side === 'long' ? 1 : -1);
  }

  /** 资金费计提：每8小时按名义价值0.01%（保守双边计费） */
  _accrueFunding(pos, time) {
    const elapsed = time - (pos.lastFundingTime || pos.openTime);
    const periods = Math.floor(elapsed / FUNDING_INTERVAL);
    if (periods <= 0) return 0;
    const fee = pos.notional * FUNDING_RATE * periods;
    pos.fundingPaid = (pos.fundingPaid || 0) + fee;
    pos.lastFundingTime = (pos.lastFundingTime || pos.openTime) + periods * FUNDING_INTERVAL;
    return fee;
  }

  /**
   * 价格更新：计提资金费 + 自动止损/止盈/强平
   */
  markPrice(symbol, price, time) {
    const closedNow = [];
    for (const pos of [...this.positions]) {
      if (pos.symbol !== symbol) continue;
      pos.lastPrice = price;
      this._accrueFunding(pos, time);
      const u = this.unrealized(pos, price) - (pos.fundingPaid || 0);
      let cause = null;
      if (u <= -pos.margin * LIQ_THRESHOLD) cause = 'liquidated';
      else if (pos.side === 'long' && pos.stop !== null && price <= pos.stop) cause = 'stop';
      else if (pos.side === 'short' && pos.stop !== null && price >= pos.stop) cause = 'stop';
      else if (pos.side === 'long' && pos.target !== null && price >= pos.target) cause = 'target';
      else if (pos.side === 'short' && pos.target !== null && price <= pos.target) cause = 'target';
      if (cause) closedNow.push(this.closePosition(pos.id, price, time, cause));
    }
    if (this.positions.length) this._save();
    return closedNow.filter(Boolean);
  }

  closePosition(id, price, time, cause = 'manual') {
    const idx = this.positions.findIndex((p) => p.id === id);
    if (idx < 0) return null;
    const pos = this.positions.splice(idx, 1)[0];
    this._accrueFunding(pos, time);
    let pnl = this.unrealized(pos, price);
    if (cause === 'liquidated') pnl = -pos.margin;
    const closeFee = cause === 'liquidated' ? 0 : pos.notional * FEE_RATE;
    const funding = pos.fundingPaid || 0;
    this.cash += pos.margin + pnl - closeFee - funding;
    const rec = {
      ...pos,
      exit: price, exitTime: time, cause,
      pnl, closeFee, funding,
      netPnl: pnl - closeFee - pos.openFee - funding,
      roiPct: ((pnl - closeFee - pos.openFee - funding) / pos.margin) * 100,
    };
    this.closed.push(rec);
    this._save();
    return rec;
  }

  equitySpot(prices = {}) {
    let eq = this.cash;
    for (const p of this.positions) {
      const px = prices[p.symbol] ?? p.lastPrice;
      eq += p.margin + this.unrealized(p, px) - (p.fundingPaid || 0);
    }
    return eq;
  }

  snapshotEquity(time, prices = {}) {
    const spot = this.equitySpot(prices);
    const last = this.equity[this.equity.length - 1];
    if (last && time - last.time < 300) return;
    this.equity.push({ time, total: +spot.toFixed(2) });
    this._save();
  }

  /** 每日收益复盘：只统计有真实平仓的日期（UTC+8日界），新在前 */
  dailyTradeReturns(n = 30) {
    const byDay = new Map();
    for (const t of this.closed) {
      const day = Math.floor((t.exitTime + 8 * 3600) / 86400);
      if (!byDay.has(day)) byDay.set(day, { day, trades: 0, wins: 0, pnl: 0, margin: 0 });
      const d = byDay.get(day);
      d.trades++;
      if (t.netPnl > 0) d.wins++;
      d.pnl += t.netPnl;
      d.margin += t.margin;
    }
    return [...byDay.values()]
      .sort((a, b) => b.day - a.day)
      .slice(0, n)
      .map((d) => ({
        ...d,
        dateLabel: new Date(d.day * 86400 * 1000).toISOString().slice(0, 10),
        roiPct: d.margin > 0 ? (d.pnl / d.margin) * 100 : null,
      }));
  }

  stats() {
    const wins = this.closed.filter((t) => t.netPnl > 0).length;
    const totalFees =
      this.closed.reduce((s, t) => s + t.openFee + t.closeFee + (t.funding || 0), 0) +
      this.positions.reduce((s, p) => s + p.openFee + (p.fundingPaid || 0), 0);
    return {
      spotTrades: this.closed.length,
      spotWins: wins,
      spotWinRate: this.closed.length ? wins / this.closed.length : null,
      spotNetPnl: this.closed.reduce((s, t) => s + t.netPnl, 0),
      totalFees,
      openCount: this.positions.length,
    };
  }
}
