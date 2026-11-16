# 核对台

一个把技术结构、已排期宏观事件和标的新闻放在一起的核对工具。动作分解释结构，不是下单指令，也不承诺收益。

覆盖比特币、HYPE（你写的 $HYPER 按 Hyperliquid 主网代币处理）、英伟达、AMD、谷歌、SpaceX（未上市，只做新闻和参考价）、费城半导体指数、纳斯达克综合指数。

浏览器打不开 `127.0.0.1`，是因为那个地址只在跑服务的那台机器上。发布后的网站走 Cursor 托管，同一套读数在服务端抓取公开行情。

本地仍可运行：

```bash
npm install
npm run dev
```

开发地址是 `http://127.0.0.1:8766`。原来的 Python 服务还在：

```bash
python3 marketdesk/server.py
```

`http://127.0.0.1:8765`。行情大约每分钟刷新。数据来自 Yahoo Finance、Kraken、OKX、Farside、美国劳工统计局、美联储和 Google 新闻。

```bash
python3 -m unittest marketdesk.tests.test_engine
npm run test:web
```
