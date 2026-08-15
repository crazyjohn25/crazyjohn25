import test from 'node:test';
import assert from 'node:assert/strict';
import { ReportArchive, generateDailyReport } from '../js/report.js';

test('generateDailyReport 含多周期/Sosovalue/策略1/策略2', () => {
  const r = generateDailyReport({
    dateLabel: '23:00',
    symbol: 'BTCUSDT',
    symbolLabel: 'BTC/USDT',
    price: 65000,
    perTf: {
      '30m': { verdict: '看多', score: 1, meta: { rsi: 55 } },
      '1h': { verdict: '强烈看多', score: 3, meta: { rsi: 62, atr: 300 } },
      '4h': { verdict: '看多', score: 2, meta: {} },
      '1d': { verdict: '看多', score: 2, meta: {} },
    },
    strategy1: { verdict: '强烈看多', totalScore: 5, sections: [{ title: '体制', lines: ['ok'] }] },
    strategy2: { verdict: '看多', totalScore: 3, sections: [{ title: '趋势组', lines: ['EMA多'] }] },
    soso: { fundingRate: 0.0002, volume24h: 1000, news: ['x'] },
    newsBias: { score: 0.3, reason: '新闻偏多' },
    topNews: [{ title: 'Fed' }],
    reflections: [],
  });
  assert.equal(r.type, 'daily-report');
  assert.ok(r.sections.some((s) => s.title.includes('多周期')));
  assert.ok(r.sections.some((s) => s.title.includes('Sosovalue')));
  assert.ok(r.sections.some((s) => s.title.includes('策略1')));
  assert.ok(r.sections.some((s) => s.title.includes('策略2')));
  assert.ok(r.summary.includes('强烈看多'));
});

test('ReportArchive 只保留日报且按日查询', () => {
  const arc = new ReportArchive({});
  arc.add({ time: 1000, type: 'daily-report', symbol: 'BTC', symbolLabel: 'BTC', price: 100, sections: [], summary: 'a' });
  arc.add({ time: 2000, type: 'daily-report', symbol: 'BTC', symbolLabel: 'BTC', price: 101, sections: [], summary: 'b' });
  assert.equal(arc.recent(10).length, 2);
  assert.equal(arc.latestDaily().summary, 'b');
  const day = Math.floor((1000 + 8 * 3600) / 86400);
  assert.equal(arc.ofDay(day).length, 2);
});
