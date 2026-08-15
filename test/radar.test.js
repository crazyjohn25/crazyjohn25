import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSignalRelevant,
  isOpenSignal,
  classifySignalBias,
  detectCoins,
  parseHandles,
  parseTgChannels,
  getKolList,
  KOLS,
} from '../js/radar.js';

test('BTC/ETH/SOL/BNB/HYPE 开仓措辞判定为相关信号', () => {
  assert.ok(isSignalRelevant('BTC long entry at 64000'));
  assert.ok(isSignalRelevant('ETH 开空 目标 2800'));
  assert.ok(isSignalRelevant('SOL breakout buy signal'));
  assert.ok(isSignalRelevant('BNB 看多 加仓'));
  assert.ok(isSignalRelevant('Hyperliquid HYPE long leverage 10x'));
  assert.ok(!isSignalRelevant('weather in tokyo today'));
  assert.ok(!isSignalRelevant('今天天气很好'));
});

test('开仓意图识别', () => {
  assert.ok(isOpenSignal('开多 BTC 68000'));
  assert.ok(isOpenSignal('Opened long ETH'));
  assert.ok(!isOpenSignal('Bitcoin analysis weekly'));
});

test('多空与标的提取', () => {
  assert.equal(classifySignalBias('开多 BTC'), 'bullish');
  assert.equal(classifySignalBias('short ETH dump'), 'bearish');
  assert.deepEqual(detectCoins('long BTC and SOL, also HYPE'), ['BTC', 'SOL', 'HYPE']);
  assert.ok(detectCoins('BNB pumping').includes('BNB'));
});

test('X账号与TG频道解析', () => {
  assert.deepEqual(parseHandles('@johnliu409, lookonchain  cz_binance'), ['johnliu409', 'lookonchain', 'cz_binance']);
  assert.deepEqual(parseTgChannels('ChannelPANews, https://t.me/foresightnews, @whales'), [
    'ChannelPANews',
    'foresightnews',
    'whales',
  ]);
});

test('默认清单含 johnliu409 且自定义账号去重合并', () => {
  assert.ok(KOLS.some((k) => k.handle.toLowerCase() === '@johnliu409'));
  const list = getKolList('johnliu409, mytrader');
  assert.equal(list.filter((k) => k.handle.toLowerCase() === '@johnliu409').length, 1);
  assert.ok(list.some((k) => k.handle === '@mytrader'));
});
