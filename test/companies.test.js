import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPANIES, getCompany } from '../js/companies.js';
import { SERENITY_PICKS } from '../js/serenity.js';

test('每个Serenity推荐都有对应公司资料', () => {
  for (const p of SERENITY_PICKS) {
    const co = COMPANIES[p.ticker];
    assert.ok(co, `缺少公司资料: ${p.ticker}`);
    assert.ok(co.name && co.name.length > 1);
    assert.ok(co.desc && co.desc.length > 10, `${p.ticker} 描述过短`);
    assert.ok(co.rank && co.rank.length > 5);
    assert.ok(Array.isArray(co.peers) && co.peers.length >= 1, `${p.ticker} 缺竞品`);
    assert.ok(co.bull && co.bull.length > 10, `${p.ticker} 缺买入理由`);
    assert.ok(co.challenge && co.challenge.length > 10, `${p.ticker} 缺challenge`);
  }
});

test('买入理由与challenge是不同内容（正反两面）', () => {
  for (const [ticker, co] of Object.entries(COMPANIES)) {
    assert.notEqual(co.bull, co.challenge, `${ticker} 正反观点相同`);
  }
});

test('getCompany 未收录返回占位而不抛错', () => {
  const co = getCompany('ZZZZ');
  assert.equal(co.name, 'ZZZZ');
  assert.ok(Array.isArray(co.peers));
});
