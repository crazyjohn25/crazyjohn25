/**
 * 成交量分析模块（纯函数）
 * 基于1小时K线做逐小时交易量统计与横向对比：
 * - 每小时交易量列表
 * - 环比（vs 上一小时）
 * - 与过去7天同一时段（同UTC小时）均值的对比
 * - 24小时总量与前一个24小时的对比
 */

/**
 * 每小时交易量统计
 * @param {Array} candles1h 1小时K线（时间升序）
 * @param {number} hours 输出最近多少个小时
 * @returns {Array<{time, hourUtc, volume, vsPrevPct, vsSameHourAvgPct, sameHourAvg}>} 新的在前
 */
export function hourlyVolumeStats(candles1h, hours = 12) {
  const n = candles1h.length;
  const rows = [];
  for (let i = n - 1; i >= Math.max(1, n - hours); i--) {
    const c = candles1h[i];
    const prev = candles1h[i - 1];
    const hourUtc = new Date(c.time * 1000).getUTCHours();

    // 过去7天同一UTC小时的成交量均值（不含当前）
    let sum = 0;
    let cnt = 0;
    for (let j = i - 1; j >= 0 && cnt < 7; j--) {
      if (new Date(candles1h[j].time * 1000).getUTCHours() === hourUtc) {
        sum += candles1h[j].volume;
        cnt++;
      }
    }
    const sameHourAvg = cnt > 0 ? sum / cnt : null;

    rows.push({
      time: c.time,
      hourUtc,
      volume: c.volume,
      vsPrevPct: prev.volume > 0 ? ((c.volume - prev.volume) / prev.volume) * 100 : null,
      vsSameHourAvgPct:
        sameHourAvg !== null && sameHourAvg > 0
          ? ((c.volume - sameHourAvg) / sameHourAvg) * 100
          : null,
      sameHourAvg,
    });
  }
  return rows;
}

/**
 * 24小时滚动总量对比
 * @returns {{ last24, prev24, changePct } | null}
 */
export function rolling24hVolume(candles1h) {
  const n = candles1h.length;
  if (n < 48) return null;
  let last24 = 0;
  let prev24 = 0;
  for (let i = n - 24; i < n; i++) last24 += candles1h[i].volume;
  for (let i = n - 48; i < n - 24; i++) prev24 += candles1h[i].volume;
  return {
    last24,
    prev24,
    changePct: prev24 > 0 ? ((last24 - prev24) / prev24) * 100 : null,
  };
}

/**
 * 各时段（UTC小时0-23）平均交易量分布，用于识别活跃时段
 * @returns {Array<{hourUtc, avgVolume, samples}>}
 */
export function hourOfDayProfile(candles1h) {
  const buckets = Array.from({ length: 24 }, () => ({ sum: 0, cnt: 0 }));
  for (const c of candles1h) {
    const h = new Date(c.time * 1000).getUTCHours();
    buckets[h].sum += c.volume;
    buckets[h].cnt++;
  }
  return buckets.map((b, hourUtc) => ({
    hourUtc,
    avgVolume: b.cnt > 0 ? b.sum / b.cnt : 0,
    samples: b.cnt,
  }));
}

/** 数字缩写显示 1234567 -> 1.23M */
export function formatVolume(v) {
  if (v === null || v === undefined) return '-';
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return v.toFixed(2);
}
