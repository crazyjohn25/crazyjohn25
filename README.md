# K线智能分析终端

基于 TradingView 开源图表库 [lightweight-charts](https://github.com/tradingview/lightweight-charts) 的K线分析工具：

1. **宏观事件标注**：将美联储议息、地缘局势（如伊朗局势）、石油价格冲击、细分赛道变化、突发行情等事件直接标注在K线图对应位置，悬停可查看详情；支持手动添加自定义事件（本地持久化）。
2. **真实宏观新闻抓取**：自动抓取 **The Block、CoinDesk、吴说区块链、AP News** 的RSS，按“与当前交易对相关或宏观高影响”过滤后进入侧栏列表，高影响新闻同步标注到K线图（每5分钟刷新）。
3. **多指标信号系统**：内置 MACD、Bollinger Band、DMI/ADX、RSI、KDJ、OBV 六大指标，通过多指标共振规则生成**买入/卖出信号**（带强度评分和触发原因），并通过页面弹窗、浏览器通知、提示音三种方式**报警**。
4. **多周期综合建议**：每30分钟在 **15m / 30m / 1h / 4h** 四个周期上综合 RSI、成交量、MACD、BOLL、KDJ、DMI 打分，按周期加权（4h权重最高）给出【买入/轻仓试多/观望/减仓防守/卖出】建议，附各周期理由与解读，可点按钮立即重算。
5. **每小时交易量对比**：主图底部叠加成交量柱；侧栏基于1小时K线列出最近12小时交易量，包含**环比**与**vs 过去7日同一时段均值**两个横向对比维度，以及24小时滚动总量对比。
6. **异常交易监控**：基于统计的量价异动检测（成交量>3σ、单根波动>2.5σ），叠加交易所实时**大额成交（鲸鱼单）**监听（Binance aggTrade / Hyperliquid trades流）。
7. **多交易所品种**：Binance（BTC/ETH/SOL/BNB-USDT）+ **Hyperliquid（HYPE/USDC）**，均使用官方公开API，无需API Key。

## 快速开始

```bash
# 启动本地静态服务器（任选其一）
npm start                     # 使用 python3 http.server，端口8080
npx serve .                   # 或使用 serve

# 浏览器打开
http://localhost:8080
```

- 行情数据默认来自**币安公开API**（REST历史K线 + WebSocket实时推送，无需API Key）。
- 若网络无法访问币安，自动降级为**本地模拟行情**离线演示，状态栏会显示"离线模式"。

## 功能说明

### 图表布局

- 主图：K线 + 布林带（上/中/下轨）+ 成交量柱 + 买卖信号箭头 + 宏观事件标记（左上角有面板标题标注）
- 副图1：**MACD(12,26,9) — 指数平滑异同移动平均线**（DIF/DEA/柱状图）
- 副图2：可切换 **RSI(14)** / **KDJ(9,3,3)** / **DMI(14)** / **OBV**，左上角标题随切换更新
- 三图时间轴联动缩放

### 多周期综合建议（每30分钟）

侧栏「综合建议」面板对 15m/30m/1h/4h 各拉取400根K线独立打分：

- MACD：DIF与DEA相对位置 ±1 分，柱体连续放大/缩小 ±0.5 分
- RSI：超卖(<30)+1 / 超买(>70)−1 / 偏强偏弱 ±0.5
- KDJ：K与D相对位置 ±0.5，超买超卖区 ±0.5
- DMI：+DI与−DI排列 ±1，ADX>25 时加权至 ±1.5
- BOLL：相对中轨/上下轨位置 ±0.5
- 成交量：近5根 vs 前20根均量，放量上涨 +0.5 / 放量下跌 −0.5

加权（15m×1、30m×1.5、1h×2、4h×3）得总分：≥1.5 买入，≥0.75 轻仓试多，≤−1.5 卖出，≤−0.75 减仓防守，其余观望。大小周期方向冲突时会额外提示。每个周期可展开查看全部理由。

### 异常数据源说明

X（Twitter）舆情与链上数据（sosovalue、Whale Alert、Arkham 等）都需要 API Key 或登录态，纯前端无法直连。`js/anomaly.js` 预留了 `fetchExternalAnomalies(apiUrl)` 钩子：自建一个代理服务返回 `[{time,title,desc,url,severity}]` 即可接入。当前版本内置的两类**真实**异常监控无需任何Key：交易所大额成交流 + 本地量价异动统计。

### 买卖信号规则（多指标共振）

单个K线上满足以下条件各计1分，**总分 ≥ 2 才触发信号**（可配置）：

| 指标 | 买入条件 | 卖出条件 |
| --- | --- | --- |
| MACD | DIF上穿DEA（金叉） | DIF下穿DEA（死叉） |
| KDJ | K线低位（<35）金叉D线 | K线高位（>65）死叉D线 |
| RSI | 从超卖区(<30)回升 | 从超买区(>70)回落 |
| BOLL | 收盘价收复下轨 | 收盘价跌回上轨内 |
| DMI | +DI上穿-DI | +DI下穿-DI |
| OBV | 量价齐升确认（辅助加分） | 量价齐跌确认（辅助加分） |
| ADX | >25（趋势成立）额外加权1分 | 同左 |

信号仅对**已收盘K线**报警，避免盘中反复触发。阈值可在 `js/signals.js` 的 `generateSignals(candles, ind, opts)` 中调整。

### 宏观事件与新闻

- 真实新闻：`js/news.js` 通过 rss2json 抓取 The Block / CoinDesk / 吴说区块链 / AP News（Google News站内检索），按当前品种关键词 + 宏观分类（美联储/地缘/石油）过滤，命中高影响关键词（加息、降息、ETF、黑客、清算等）的会标注到K线图上。
- 内置示例事件位于 `js/events.js` 的 `BUILTIN_EVENTS`；侧栏可添加自定义事件，保存于浏览器 localStorage。

## 目录结构

```
index.html          页面入口
css/style.css       样式
js/indicators.js    指标计算（MACD/BOLL/RSI/KDJ/DMI/OBV，纯函数）
js/signals.js       信号引擎 + 报警管理器
js/advisor.js       多周期综合建议引擎（15m/30m/1h/4h加权打分）
js/volume.js        每小时交易量统计与横向对比（纯函数）
js/anomaly.js       异常交易检测（量价异动统计 + 鲸鱼单缓存 + 外部源钩子）
js/news.js          真实宏观新闻抓取与相关性过滤
js/events.js        宏观事件（内置/自定义）
js/datafeed.js      行情数据源（Binance + Hyperliquid + 离线模拟降级）
js/app.js           页面主逻辑
test/               单元测试（node:test）
```

## 测试

```bash
npm test
```

## 风险提示

本工具产生的信号仅基于技术指标规则，属于辅助参考，**不构成投资建议**。
