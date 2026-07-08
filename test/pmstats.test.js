import test from 'node:test';
import assert from 'node:assert/strict';
import { PmHistory, classifyMiss, pmDeepStats, pmReflections } from '../js/pmstats.js';

function rec(over = {}) {
  return {
    winStart: 1000,
    winEnd: 1300,
    action: '买Up',
    edge: 0.12,
    techProb: 0.62,
    strike: 100,
    priceAtCall: 100.05,
    secondsLeftAtCall: 120,
    leadPct: 0.05,
    flowBias: 0.2,
    bookImbalance: 0.1,
    upPrice: 0.5,
    reasons: ['r1'],
    ...over,
  };
}

test('record 方向建议不被后续观望覆盖', () => {
  const h = new PmHistory({});
  h.record(rec({ action: '买Up' }));
  h.record(rec({ action: '临近结算，勿追单' }));
  assert.equal(h.records[0].action, '买Up');
});

test('record 观望可被方向建议升级覆盖', () => {
  const h = new PmHistory({});
  h.record(rec({ action: '无优势，观望' }));
  h.record(rec({ action: '买Down' }));
  assert.equal(h.records[0].action, '买Down');
});

test('settle 判定结果与命中', () => {
  const h = new PmHistory({});
  h.record(rec({ winStart: 1000, winEnd: 1300, action: '买Up', strike: 100 }));
  h.record(rec({ winStart: 2000, winEnd: 2300, action: '买Down', strike: 100 }));
  const settled = h.settle((t) => (t === 1300 ? 101 : 99), 5000);
  assert.equal(settled.length, 2);
  assert.equal(settled[0].outcome, 'up');
  assert.equal(settled[0].hit, true);
  assert.equal(settled[1].outcome, 'down');
  assert.equal(settled[1].hit, true);
});

test('classifyMiss 归因：领先过薄优先', () => {
  const cause = classifyMiss(rec({ leadPct: 0.005, secondsLeftAtCall: 250 }));
  assert.equal(cause.code, 'thin_lead');
});

test('classifyMiss 归因：入场过早', () => {
  const cause = classifyMiss(rec({ leadPct: 0.08, secondsLeftAtCall: 250 }));
  assert.equal(cause.code, 'too_early');
});

test('classifyMiss 归因：资金流误导', () => {
  const cause = classifyMiss(rec({ leadPct: 0.08, secondsLeftAtCall: 100, action: '买Up', flowBias: 0.5 }));
  assert.equal(cause.code, 'flow_trap');
});

test('pmDeepStats 统计与理论盈亏', () => {
  const h = new PmHistory({});
  // 3胜1负，upPrice=0.5：胜+0.5×3，负-0.5 → +1.0
  for (let i = 0; i < 4; i++) {
    h.record(rec({ winStart: i * 1000, winEnd: i * 1000 + 300, action: '买Up', strike: 100 }));
  }
  h.settle((t) => (t < 3300 ? 101 : 99), 99999);
  const s = pmDeepStats(h.records);
  assert.equal(s.total, 4);
  assert.equal(s.hits, 3);
  assert.ok(Math.abs(s.pnl - 1.0) < 1e-9);
  assert.ok(s.timeBuckets['剩余1.5-3分钟']);
});

test('pmReflections 样本不足提示', () => {
  const out = pmReflections(pmDeepStats([]));
  assert.ok(out[0].includes('样本不足'));
});

test('pmReflections 低命中时段被点名', () => {
  const h = new PmHistory({});
  for (let i = 0; i < 6; i++) {
    h.record(
      rec({ winStart: i * 1000, winEnd: i * 1000 + 300, action: '买Up', strike: 100, secondsLeftAtCall: 250, leadPct: 0.005 })
    );
  }
  h.settle(() => 99, 99999); // 全错
  const s = pmDeepStats(h.records);
  const out = pmReflections(s);
  assert.ok(out.some((x) => x.includes('剩余>3分钟')));
  assert.ok(out.some((x) => x.includes('领先优势过薄')));
});
