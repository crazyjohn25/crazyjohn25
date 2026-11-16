import { isoWeek } from "./week.mjs";
import { NY, nyClock, parts } from "./time.mjs";

export function resample(bars, bucket) {
  const groups = [];
  let current = null;
  let key = null;
  for (const bar of bars) {
    const k = bucket(bar.t);
    const token = JSON.stringify(k);
    if (current === null || token !== key) {
      if (current !== null) groups.push(current);
      current = { t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v || 0 };
      key = token;
    } else {
      current.h = Math.max(current.h, bar.h);
      current.l = Math.min(current.l, bar.l);
      current.c = bar.c;
      current.v += bar.v || 0;
    }
  }
  if (current !== null) groups.push(current);
  return groups;
}

export function toWeekly(dailyBars) {
  return resample(dailyBars, isoWeek);
}

export function toEquity4h(hourlyBars) {
  return resample(hourlyBars, (ts) => {
    const p = parts(ts, NY);
    const half = p.hour < 13 ? 0 : 1;
    return [p.year, p.month, p.day, half];
  });
}

export function barIsClosed(bar, intervalSec, assetClass, now) {
  if (intervalSec >= 86400 * 5) {
    return JSON.stringify(isoWeek(Math.floor(now))) !== JSON.stringify(isoWeek(bar.t)) && bar.t + intervalSec <= now + 2;
  }
  if (assetClass !== "crypto" && intervalSec >= 86400) {
    return now >= nyClock(bar.t, 16, 0);
  }
  if (assetClass !== "crypto" && intervalSec === 14400) {
    const p = parts(bar.t, NY);
    const endClock = p.hour < 13 ? nyClock(bar.t, 13, 0) : nyClock(bar.t, 16, 0);
    return now >= endClock;
  }
  return bar.t + intervalSec <= now + 1;
}

export function splitClosed(bars, intervalSec, assetClass, now) {
  if (!bars.length) return [[], null];
  if (barIsClosed(bars[bars.length - 1], intervalSec, assetClass, now)) return [bars, null];
  if (bars.length === 1) return [[], bars[bars.length - 1]];
  return [bars.slice(0, -1), bars[bars.length - 1]];
}

export function closedWeeks(dailyBars, now) {
  const weeks = toWeekly(dailyBars);
  if (!weeks.length) return [];
  if (JSON.stringify(isoWeek(weeks[weeks.length - 1].t)) === JSON.stringify(isoWeek(Math.floor(now)))) {
    return weeks.slice(0, -1);
  }
  return weeks;
}

export function returnOver(bars, n = 20) {
  if (bars.length <= n) return null;
  const start = bars[bars.length - 1 - n].c;
  const end = bars[bars.length - 1].c;
  if (!start) return null;
  return end / start - 1;
}
