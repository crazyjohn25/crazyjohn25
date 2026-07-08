import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyScope, interpret } from '../js/interpret.js';

test('降息类新闻归宏观且利好', () => {
  const r = interpret('Fed announces rate cut of 25bp');
  assert.equal(r.scope, 'macro');
  assert.equal(r.bias, 'bullish');
  assert.ok(r.reason.length > 10);
  assert.ok(r.risk.length > 10);
});

test('加息中文关键词归宏观且利空', () => {
  const r = interpret('美联储宣布加息50个基点');
  assert.equal(r.scope, 'macro');
  assert.equal(r.bias, 'bearish');
});

test('非农数据归宏观中性并提示波动风险', () => {
  const r = interpret('US nonfarm payrolls beat expectations');
  assert.equal(r.scope, 'macro');
  assert.equal(r.bias, 'neutral');
  assert.ok(r.risk.includes('非农') || r.risk.includes('止损'));
});

test('战争类归宏观利空', () => {
  const r = interpret('Iran launches missile attack');
  assert.equal(r.scope, 'macro');
  assert.equal(r.bias, 'bearish');
  assert.ok(r.target.includes('原油') || r.target.includes('黄金') || r.target.includes('风险资产'));
});

test('MicroStrategy增持归微观利好BTC', () => {
  const r = interpret('MicroStrategy buys another 5000 BTC');
  assert.equal(r.scope, 'micro');
  assert.equal(r.bias, 'bullish');
  assert.ok(r.target.includes('BTC'));
  assert.ok(r.risk.length > 10);
});

test('黑客事件归微观利空', () => {
  const r = interpret('DeFi protocol hacked for $50 million');
  assert.equal(r.scope, 'micro');
  assert.equal(r.bias, 'bearish');
});

test('财报超预期归微观利好', () => {
  const r = interpret('Company earnings beat estimates, raises guidance');
  assert.equal(r.scope, 'micro');
  assert.equal(r.bias, 'bullish');
});

test('未命中规则时给中性默认解读', () => {
  const r = interpret('Some random project announcement today');
  assert.equal(r.bias, 'neutral');
  assert.ok(r.reason.length > 0);
  assert.ok(r.risk.length > 0);
});

test('classifyScope 与 interpret 的scope一致', () => {
  for (const t of ['Fed rate decision', 'Protocol upgrade released', '油价上涨', '某公司财报超预期']) {
    assert.equal(classifyScope(t), interpret(t).scope);
  }
});
