import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SERENITY_PICKS,
  INDUSTRIES,
  NARRATIVES,
  buildSerenityIndex,
  scorePick,
} from '../js/serenity.js';

function dailySeries(startPrice, dailyPct, days = 40, endSec = 1783400000) {
  const out = [];
  let p = startPrice;
  for (let i = days - 1; i >= 0; i--) {
    const open = p;
    p = p * (1 + dailyPct);
    out.push({ time: endSec - i * 86400, open, high: p * 1.01, low: open * 0.99, close: p, volume: 1000 });
  }
  return out;
}

test('数据集完整：行业与叙事标签均有效', () => {
  assert.ok(SERENITY_PICKS.length >= 10);
  for (const p of SERENITY_PICKS) {
    assert.ok(INDUSTRIES[p.industry], `未知行业: ${p.industry}`);
    assert.ok(NARRATIVES[p.narrative], `未知叙事: ${p.narrative}`);
    assert.ok(p.note.length > 5);
    assert.ok(typeof p.date === 'number');
  }
});

test('buildSerenityIndex 上涨组合指数>100', () => {
  const daily = {};
  for (const p of SERENITY_PICKS) {
    daily[p.ticker] = { candles: dailySeries(100, 0.01) }; // 每天+1%
  }
  const idx = buildSerenityIndex(daily, 30, 1783400000);
  assert.ok(idx);
  assert.ok(idx.current > 100, `应>100，实际${idx.current}`);
  assert.ok(idx.changePct > 0);
  assert.equal(idx.covered, SERENITY_PICKS.length);
  assert.ok(idx.series.length >= 2);
});

test('buildSerenityIndex 部分数据缺失仍可合成', () => {
  const daily = {};
  daily[SERENITY_PICKS[0].ticker] = { candles: dailySeries(50, 0.02) };
  daily[SERENITY_PICKS[1].ticker] = { candles: dailySeries(200, -0.01) };
  const idx = buildSerenityIndex(daily, 30, 1783400000);
  assert.ok(idx);
  assert.equal(idx.covered, 2);
});

test('buildSerenityIndex 无数据返回null', () => {
  assert.equal(buildSerenityIndex({}, 30, 1783400000), null);
});

test('scorePick：核心叙事+涨幅+披露得分更高', () => {
  const core = SERENITY_PICKS.find((p) => p.narrative === 'chokepoint' && p.disclosed);
  const fringe = SERENITY_PICKS.find((p) => p.narrative === 'exposure' && !p.disclosed);
  const up = dailySeries(100, 0.01);
  const down = dailySeries(100, -0.01);
  const sCore = scorePick(core, up);
  const sFringe = scorePick(fringe, down);
  assert.ok(sCore.score > sFringe.score);
  assert.ok(sCore.perf30 > 0);
  assert.ok(sFringe.perf30 < 0);
  assert.ok(sCore.score <= 10 && sFringe.score >= 0);
});

test('scorePick 无行情时只用叙事权重', () => {
  const p = SERENITY_PICKS[0];
  const { score, perf30 } = scorePick(p, null);
  assert.equal(perf30, null);
  assert.ok(score > 0);
});
