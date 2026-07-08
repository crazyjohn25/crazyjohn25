/**
 * 模拟交易钱包（Paper Trading）
 * - 合约钱包：初始$10000，单笔保证金$500-1000，杠杆20-100x，
 *   吃单手续费 0.05%/边（按名义价值，参照币安USDT永续taker费率），
 *   止损/止盈自动平仓，亏损达保证金95%触发强平（简化的逐仓模型，不含资金费率）。
 *   高杠杆警示：50x下价格反向1.9%即强平，止损必须严格执行。
 * - PM钱包：初始$1000，每注$50-100，按订单簿真实卖一价买入份额，命中每份赔付$1。
 * - 支持手动注资（增加虚拟资本）。
 * - 权益快照：每小时记录，支持每日/每小时收益复盘。
 * 核心风控：最多3个并存仓位、同品种同策略去重、6小时同键冷却、只做高置信信号。
 */

export const FEE_RATE = 0.0005; // taker 0.05%/边
export const MARGIN_MIN = 500;
export const MARGIN_MAX = 1000;
export const LEV_MIN = 20;
export const LEV_MAX = 100;
const LIQ_THRESHOLD = 0.95; // 亏损达保证金95%强平

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
    this.key = opts.key || 'kchart.paperWallet.v2';
    this.maxOpen = opts.maxOpen || 3;
    this.cooldownSec = opts.cooldownSec || 6 * 3600;
    const s = this._load();
    this.cash = s.cash ?? 10000;
    this.pmCash = s.pmCash ?? 1000;
    this.baseCapital = s.baseCapital ?? 11000; // 初始本金+历次注资，收益率基准
    this.positions = s.positions || [];
    this.closed = s.closed || [];
    this.bets = s.bets || [];
    this.settledBets = s.settledBets || [];
    this.equity = s.equity || [];
    this.lastEntry = s.lastEntry || {}; // `${symbol}|${strategy}` -> time
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
    if (this.closed.length > 200) this.closed = this.closed.slice(-200);
    if (this.settledBets.length > 300) this.settledBets = this.settledBets.slice(-300);
    if (this.equity.length > 1000) this.equity = this.equity.slice(-1000);
    this.storage.setItem(
      this.key,
      JSON.stringify({
        cash: this.cash,
        pmCash: this.pmCash,
        baseCapital: this.baseCapital,
        positions: this.positions,
        closed: this.closed,
        bets: this.bets,
        settledBets: this.settledBets,
        equity: this.equity,
        lastEntry: this.lastEntry,
        createdAt: this.createdAt,
      })
    );
  }

  // ---------------- 合约 ----------------

  /**
   * 开仓（含风控检查）
   * @returns {Object|{rejected:string}} 持仓 或 拒绝原因
   */
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
    if (this.cash < margin + fee) return { rejected: '合约钱包余额不足' };

    this.cash -= margin + fee;
    const pos = {
      id: `p${time}_${Math.random().toString(36).slice(2, 6)}`,
      symbol, side, entry: price, margin, leverage, notional,
      stop: stop ?? null, target: target ?? null,
      openFee: fee, reason: reason || '', strategy: strategy || '-',
      openTime: time, lastPrice: price,
    };
    this.positions.push(pos);
    this.lastEntry[k] = time;
    this._save();
    return pos;
  }

  /** 未实现盈亏 */
  unrealized(pos, price) {
    const chg = (price - pos.entry) / pos.entry;
    return pos.notional * chg * (pos.side === 'long' ? 1 : -1);
  }

  /**
   * 价格更新：自动止损/止盈/强平
   * @returns {Array} 本次自动平仓的成交
   */
  markPrice(symbol, price, time) {
    const closedNow = [];
    for (const pos of [...this.positions]) {
      if (pos.symbol !== symbol) continue;
      pos.lastPrice = price;
      const u = this.unrealized(pos, price);
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
    let pnl = this.unrealized(pos, price);
    if (cause === 'liquidated') pnl = -pos.margin; // 强平：损失全部保证金
    const closeFee = cause === 'liquidated' ? 0 : pos.notional * FEE_RATE;
    this.cash += pos.margin + pnl - closeFee;
    const rec = {
      ...pos,
      exit: price, exitTime: time, cause,
      pnl, closeFee,
      netPnl: pnl - closeFee - pos.openFee,
      roiPct: ((pnl - closeFee - pos.openFee) / pos.margin) * 100,
    };
    this.closed.push(rec);
    this._save();
    return rec;
  }

  /** 合约权益（含浮盈浮亏） */
  equitySpot(prices = {}) {
    let eq = this.cash;
    for (const p of this.positions) {
      const px = prices[p.symbol] ?? p.lastPrice;
      eq += p.margin + this.unrealized(p, px);
    }
    return eq;
  }

  // ---------------- PM 5分钟下注 ----------------

  placePmBet({ winStart, side, cost, stake, time, reason }) {
    stake = Math.max(50, Math.min(100, stake || 50));
    if (!cost || cost <= 0.02 || cost >= 0.98) return { rejected: '成本价异常' };
    if (this.bets.some((b) => b.winStart === winStart)) return { rejected: '本窗口已下注' };
    if (this.pmCash < stake) return { rejected: 'PM钱包余额不足' };
    this.pmCash -= stake;
    const bet = {
      id: `b${winStart}`,
      winStart, side, cost, stake,
      shares: stake / cost,
      time, reason: reason || '',
    };
    this.bets.push(bet);
    this._save();
    return bet;
  }

  /** 结算指定窗口 */
  settlePmBet(winStart, outcome) {
    const idx = this.bets.findIndex((b) => b.winStart === winStart);
    if (idx < 0) return null;
    const bet = this.bets.splice(idx, 1)[0];
    const won = bet.side === outcome;
    const payout = won ? bet.shares : 0;
    this.pmCash += payout;
    const rec = { ...bet, outcome, won, payout, pnl: payout - bet.stake, roiPct: ((payout - bet.stake) / bet.stake) * 100 };
    this.settledBets.push(rec);
    this._save();
    return rec;
  }

  pmEquity() {
    // 未结算注按成本计
    return this.pmCash + this.bets.reduce((s, b) => s + b.stake, 0);
  }

  /** 手动注资（增加虚拟资本），同步抬高收益率基准，不虚增收益 */
  addFunds(amount, target = 'spot') {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > 1000000) return false;
    if (target === 'pm') this.pmCash += amt;
    else this.cash += amt;
    this.baseCapital += amt;
    this._save();
    return true;
  }

  // ---------------- 权益快照与复盘 ----------------

  snapshotEquity(time, prices = {}) {
    const spot = this.equitySpot(prices);
    const pmEq = this.pmEquity();
    const last = this.equity[this.equity.length - 1];
    if (last && time - last.time < 300) return; // 5分钟内不重复记
    this.equity.push({ time, spot: +spot.toFixed(2), pm: +pmEq.toFixed(2), total: +(spot + pmEq).toFixed(2) });
    this._save();
  }

  /** 每日收益复盘（UTC+8日界），新在前 */
  dailyReturns(n = 14) {
    const byDay = new Map();
    for (const e of this.equity) {
      const day = Math.floor((e.time + 8 * 3600) / 86400);
      byDay.set(day, e); // 保留当日最后一条
    }
    const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
    const out = [];
    for (let i = 1; i < days.length; i++) {
      const [day, e] = days[i];
      const prev = days[i - 1][1];
      out.push({
        day,
        dateLabel: new Date(day * 86400 * 1000).toISOString().slice(0, 10),
        total: e.total,
        pnl: +(e.total - prev.total).toFixed(2),
        retPct: prev.total > 0 ? ((e.total - prev.total) / prev.total) * 100 : null,
      });
    }
    return out.slice(-n).reverse();
  }

  /** 每小时收益（最近n小时），新在前 */
  hourlyReturns(n = 24) {
    const byHour = new Map();
    for (const e of this.equity) {
      byHour.set(Math.floor(e.time / 3600), e);
    }
    const hours = [...byHour.entries()].sort((a, b) => a[0] - b[0]);
    const out = [];
    for (let i = 1; i < hours.length; i++) {
      const [hr, e] = hours[i];
      const prev = hours[i - 1][1];
      out.push({
        time: hr * 3600,
        total: e.total,
        pnl: +(e.total - prev.total).toFixed(2),
        retPct: prev.total > 0 ? ((e.total - prev.total) / prev.total) * 100 : null,
      });
    }
    return out.slice(-n).reverse();
  }

  /** 汇总统计 */
  stats() {
    const wins = this.closed.filter((t) => t.netPnl > 0).length;
    const betWins = this.settledBets.filter((b) => b.won).length;
    const totalFees = this.closed.reduce((s, t) => s + t.openFee + t.closeFee, 0) +
      this.positions.reduce((s, p) => s + p.openFee, 0);
    return {
      spotTrades: this.closed.length,
      spotWins: wins,
      spotWinRate: this.closed.length ? wins / this.closed.length : null,
      spotNetPnl: this.closed.reduce((s, t) => s + t.netPnl, 0),
      totalFees,
      pmBets: this.settledBets.length,
      pmWins: betWins,
      pmWinRate: this.settledBets.length ? betWins / this.settledBets.length : null,
      pmNetPnl: this.settledBets.reduce((s, b) => s + b.pnl, 0),
    };
  }
}
