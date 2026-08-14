import test from 'node:test';
import assert from 'node:assert/strict';
import { bsGamma, parseInstrument, computeGex, explainGex } from '../js/gamma.js';

test('bsGamma 平值近期权Gamma最大', () => {
  const now = Math.floor(Date.now() / 1000);
  const t = 7 / 365; // 7天
  const atm = bsGamma(65000, 65000, t, 50);
  const otm = bsGamma(65000, 80000, t, 50);
  const deep = bsGamma(65000, 120000, t, 50);
  assert.ok(atm > otm && otm > deep);
  assert.ok(atm > 0);
});

test('bsGamma 非法输入返回0', () => {
  assert.equal(bsGamma(0, 100, 1, 50), 0);
  assert.equal(bsGamma(100, 100, 0, 50), 0);
  assert.equal(bsGamma(100, 100, 1, 0), 0);
});

test('parseInstrument 解析Deribit合约名', () => {
  const c = parseInstrument('BTC-25JUN27-68000-C');
  assert.equal(c.strike, 68000);
  assert.ok(c.isCall);
  assert.ok(c.expiry > 0);
  const p = parseInstrument('ETH-15AUG26-3000-P');
  assert.equal(p.strike, 3000);
  assert.ok(!p.isCall);
  assert.equal(parseInstrument('invalid'), null);
});

test('computeGex 看涨OI大于看跌时为正Gamma', () => {
  const now = Math.floor(Date.now() / 1000);
  const mk = (name, oi, iv) => ({
    instrument_name: name,
    open_interest: oi,
    mark_iv: iv,
    underlying_price: 65000,
  });
  const rows = [
    mk('BTC-19SEP26-65000-C', 100, 50),
    mk('BTC-19SEP26-65000-P', 20, 50),
    mk('BTC-19SEP26-70000-C', 80, 55),
    mk('BTC-19SEP26-60000-P', 30, 55),
  ];
  const g = computeGex(rows, now);
  assert.ok(g);
  assert.equal(g.regime, 'positive');
  assert.ok(g.gex > 0);
  assert.equal(g.spot, 65000);
  assert.ok(g.callWall && g.putWall);
  assert.ok(g.totalOi > 0);
});

test('computeGex 看跌OI主导时为负Gamma', () => {
  const now = Math.floor(Date.now() / 1000);
  const mk = (name, oi, iv) => ({ instrument_name: name, open_interest: oi, mark_iv: iv, underlying_price: 65000 });
  const g = computeGex([mk('BTC-19SEP26-65000-C', 10, 50), mk('BTC-19SEP26-65000-P', 200, 50)], now);
  assert.equal(g.regime, 'negative');
  assert.ok(g.gex < 0);
});

test('computeGex 空数据返回null', () => {
  assert.equal(computeGex([]), null);
  assert.equal(computeGex(null), null);
});

test('explainGex 正/负Gamma给出不同解读', () => {
  const pos = explainGex({ regime: 'positive', gex: 5e6, callWall: { strike: 70000 }, putWall: { strike: 60000 } });
  assert.ok(pos.includes('正Gamma') && pos.includes('区间'));
  const neg = explainGex({ regime: 'negative', gex: -3e6, callWall: { strike: 70000 }, putWall: { strike: 60000 } });
  assert.ok(neg.includes('负Gamma') && neg.includes('趋势'));
  assert.ok(explainGex(null).includes('不可用'));
});
