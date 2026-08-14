import test from 'node:test';
import assert from 'node:assert/strict';
import { ReportArchive, generateReport, generateDailyReview } from '../js/report.js';

test('generateReport 产出结构化报告含技术/Gamma/新闻/策略', () => {
  const r = generateReport({
    symbol: 'BTCUSDT',
    symbolLabel: 'BTC/USDT',
    price: 65000,
    strategies: [{ label: '短线策略（1-6小时）', action: '买入', score: 2.5, conf: 0.6 }],
    perTf: {
      '1h': { verdict: '看多', score: 2, meta: { rsi: 58, atr: 320, vwap: 64800, support: 64000, resistance: 66000 } },
    },
    gamma: { regime: 'positive', gex: 5e6, callWall: { strike: 70000 }, putWall: { strike: 60000 } },
    newsBias: { score: 0.3, reason: '新闻面：利好3条 vs 利空1条' },
  });
  assert.ok(r.time > 0);
  assert.equal(r.sections.length, 4);
  assert.ok(r.sections[0].lines[0].includes('RSI=58'));
  assert.ok(r.sections[1].lines[0].includes('正Gamma'));
  assert.ok(r.summary.includes('买入'));
});

test('generateReport 无Gamma/新闻时正常降级', () => {
  const r = generateReport({
    symbol: 'SOLUSDT', symbolLabel: 'SOL', price: 150,
    strategies: [], perTf: {}, gamma: null, newsBias: null,
  });
  assert.equal(r.sections.length, 2); // 技术面(空) + 策略结论
});

test('ReportArchive 存档与按日查询', () => {
  const arc = new ReportArchive({});
  arc.add({ time: 1000, symbol: 'BTC', symbolLabel: 'BTC', price: 100, sections: [], summary: 'a' });
  arc.add({ time: 2000, symbol: 'BTC', symbolLabel: 'BTC', price: 101, sections: [], summary: 'b' });
  assert.equal(arc.recent(10).length, 2);
  assert.equal(arc.recent(1)[0].summary, 'b', '新在前');
  const day = Math.floor((1000 + 8 * 3600) / 86400);
  assert.equal(arc.ofDay(day).length, 2);
});

test('generateDailyReview 汇总当日平仓与反思', () => {
  const r = generateDailyReview({
    dateLabel: '10:00',
    reports: [{}, {}],
    walletStats: { spotTrades: 5, spotWinRate: 0.6, spotNetPnl: 120, totalFees: 15 },
    closedToday: [{ netPnl: 80 }, { netPnl: -20 }, { netPnl: 60 }],
    topNews: [{ title: 'Fed holds rates' }],
    reflections: ['短线胜率偏低'],
  });
  assert.equal(r.type, 'daily-review');
  assert.ok(r.lines.some((l) => l.includes('平仓 3 笔') && l.includes('净盈亏 +$120.0')));
  assert.ok(r.lines.some((l) => l.includes('胜率60%')));
  assert.ok(r.lines.some((l) => l.includes('Fed holds rates')));
  assert.ok(r.lines.some((l) => l.includes('短线胜率偏低')));
});

test('generateDailyReview 无平仓日如实记录', () => {
  const r = generateDailyReview({ dateLabel: '23:00', reports: [], walletStats: null, closedToday: [], topNews: [], reflections: [] });
  assert.ok(r.lines.some((l) => l.includes('今日无平仓')));
});
