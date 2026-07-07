/**
 * 买卖信号引擎
 * 基于多个技术指标的组合规则，为每根K线生成买入/卖出信号。
 * 每个信号带有触发原因和强度评分，供图表标注和报警使用。
 */

/** 判断两条线在 i 处是否发生金叉（fast 上穿 slow） */
function crossUp(fast, slow, i) {
  return (
    i > 0 &&
    fast[i - 1] !== null &&
    slow[i - 1] !== null &&
    fast[i] !== null &&
    slow[i] !== null &&
    fast[i - 1] <= slow[i - 1] &&
    fast[i] > slow[i]
  );
}

/** 判断两条线在 i 处是否发生死叉（fast 下穿 slow） */
function crossDown(fast, slow, i) {
  return (
    i > 0 &&
    fast[i - 1] !== null &&
    slow[i - 1] !== null &&
    fast[i] !== null &&
    slow[i] !== null &&
    fast[i - 1] >= slow[i - 1] &&
    fast[i] < slow[i]
  );
}

/**
 * 生成信号列表
 * @param {Array} candles K线数组
 * @param {Object} ind computeAll 的输出
 * @param {Object} opts 阈值配置
 * @returns {Array<{time, index, side, score, reasons}>}
 */
export function generateSignals(candles, ind, opts = {}) {
  const cfg = {
    rsiOversold: 30,
    rsiOverbought: 70,
    kdjOversold: 20,
    kdjOverbought: 80,
    adxTrendMin: 25, // ADX 高于该值认为趋势成立，信号加权
    minScore: 2, // 至少两个指标共振才产生信号
    ...opts,
  };

  const signals = [];
  const { macd, boll, rsi, kdj, dmi, obv } = ind;

  for (let i = 1; i < candles.length; i++) {
    const buyReasons = [];
    const sellReasons = [];
    const c = candles[i];

    // --- MACD ---
    if (crossUp(macd.dif, macd.dea, i)) buyReasons.push('MACD金叉');
    if (crossDown(macd.dif, macd.dea, i)) sellReasons.push('MACD死叉');

    // --- KDJ ---
    if (
      crossUp(kdj.k, kdj.d, i) &&
      kdj.k[i - 1] !== null &&
      kdj.k[i - 1] < cfg.kdjOversold + 15
    ) {
      buyReasons.push('KDJ低位金叉');
    }
    if (
      crossDown(kdj.k, kdj.d, i) &&
      kdj.k[i - 1] !== null &&
      kdj.k[i - 1] > cfg.kdjOverbought - 15
    ) {
      sellReasons.push('KDJ高位死叉');
    }

    // --- RSI 从超卖/超买区回归 ---
    if (
      rsi[i - 1] !== null &&
      rsi[i] !== null &&
      rsi[i - 1] < cfg.rsiOversold &&
      rsi[i] >= cfg.rsiOversold
    ) {
      buyReasons.push(`RSI脱离超卖区(${rsi[i].toFixed(1)})`);
    }
    if (
      rsi[i - 1] !== null &&
      rsi[i] !== null &&
      rsi[i - 1] > cfg.rsiOverbought &&
      rsi[i] <= cfg.rsiOverbought
    ) {
      sellReasons.push(`RSI脱离超买区(${rsi[i].toFixed(1)})`);
    }

    // --- 布林带触碰反转 ---
    if (
      boll.lower[i] !== null &&
      boll.lower[i - 1] !== null &&
      candles[i - 1].close < boll.lower[i - 1] &&
      c.close > boll.lower[i]
    ) {
      buyReasons.push('收复布林下轨');
    }
    if (
      boll.upper[i] !== null &&
      boll.upper[i - 1] !== null &&
      candles[i - 1].close > boll.upper[i - 1] &&
      c.close < boll.upper[i]
    ) {
      sellReasons.push('跌回布林上轨内');
    }

    // --- DMI 方向 ---
    if (crossUp(dmi.pdi, dmi.mdi, i)) buyReasons.push('DMI +DI上穿-DI');
    if (crossDown(dmi.pdi, dmi.mdi, i)) sellReasons.push('DMI +DI下穿-DI');

    // --- OBV 量价确认（近5根K线 OBV 走势与价格同向） ---
    if (i >= 5 && obv[i] !== null && obv[i - 5] !== null) {
      const obvUp = obv[i] > obv[i - 5];
      const priceUp = c.close > candles[i - 5].close;
      if (obvUp && priceUp && buyReasons.length > 0)
        buyReasons.push('OBV量价齐升确认');
      if (!obvUp && !priceUp && sellReasons.length > 0)
        sellReasons.push('OBV量价齐跌确认');
    }

    // --- ADX 趋势加权 ---
    const trendBonus =
      dmi.adx[i] !== null && dmi.adx[i] > cfg.adxTrendMin ? 1 : 0;

    const buyScore = buyReasons.length + (buyReasons.length > 0 ? trendBonus : 0);
    const sellScore =
      sellReasons.length + (sellReasons.length > 0 ? trendBonus : 0);

    if (buyScore >= cfg.minScore && buyScore > sellScore) {
      signals.push({
        time: c.time,
        index: i,
        side: 'buy',
        price: c.close,
        score: buyScore,
        reasons: buyReasons,
      });
    } else if (sellScore >= cfg.minScore && sellScore > buyScore) {
      signals.push({
        time: c.time,
        index: i,
        side: 'sell',
        price: c.close,
        score: sellScore,
        reasons: sellReasons,
      });
    }
  }
  return signals;
}

/**
 * 报警管理器：新信号出现时触发浏览器通知 + 页面内提示 + 声音
 */
export class AlertManager {
  constructor({ onAlert } = {}) {
    this.seen = new Set();
    this.onAlert = onAlert; // 页面内回调
    this.muted = false;
    this.primed = false; // 首次check只登记历史信号，不报警
  }

  requestPermission() {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  /** 品种/周期切换后重置首检状态，避免把切换后的历史信号当成新信号 */
  reset() {
    this.primed = false;
  }

  /**
   * 检查信号列表，只对未见过的信号报警。
   * 首次调用（含reset后）只登记已有历史信号，不触发报警，
   * 防止加载500根历史K线时瞬间弹出几十条通知。
   */
  check(signals, symbol) {
    const isFirst = !this.primed;
    this.primed = true;
    for (const s of signals) {
      const key = `${symbol}|${s.time}|${s.side}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (!isFirst) this.fire(s, symbol);
    }
  }

  fire(signal, symbol) {
    const title = `${symbol} ${signal.side === 'buy' ? '买入' : '卖出'}信号 (强度${signal.score})`;
    const body = signal.reasons.join('；');
    if (this.onAlert) this.onAlert({ signal, symbol, title, body });
    if (
      !this.muted &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    ) {
      new Notification(title, { body });
    }
    this.beep(signal.side);
  }

  beep(side) {
    if (this.muted || typeof AudioContext === 'undefined') return;
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = side === 'buy' ? 880 : 440;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
      osc.onended = () => ctx.close();
    } catch (_) {
      /* 浏览器策略可能禁止自动播放，忽略 */
    }
  }
}
