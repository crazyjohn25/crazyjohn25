# K线智能分析终端

基于 TradingView 开源图表库 [lightweight-charts](https://github.com/tradingview/lightweight-charts) 的K线分析工具：

1. **宏观事件标注**：将美联储议息、地缘局势（如伊朗局势）、石油价格冲击、细分赛道变化、突发行情等事件直接标注在K线图对应位置，悬停可查看详情；支持手动添加自定义事件（本地持久化），并预留实时事件API接入钩子。
2. **多指标信号系统**：内置 MACD、Bollinger Band、DMI/ADX、RSI、KDJ、OBV 六大指标，通过多指标共振规则生成**买入/卖出信号**（带强度评分和触发原因），并通过页面弹窗、浏览器通知、提示音三种方式**报警**。

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

- 主图：K线 + 布林带（上/中/下轨）+ 买卖信号箭头 + 宏观事件标记
- 副图1：MACD（DIF/DEA/柱状图）
- 副图2：可切换 RSI / KDJ / DMI / OBV
- 三图时间轴联动缩放

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

### 宏观事件

- 内置示例事件（美联储决议、伊朗局势、油价冲击等）位于 `js/events.js` 的 `BUILTIN_EVENTS`。
- 页面侧栏可添加自定义事件，保存于浏览器 localStorage。
- **实时收集接入**：在 `js/app.js` 中配置 `LIVE_EVENTS_API` 为你的事件JSON接口（如自建爬虫服务、财经日历API的代理），返回格式为 `[{time(秒时间戳), title, category, impact, note}]`，前端每5分钟自动刷新。category 取值：`fed | geo | oil | sector | breaking | other`。

## 目录结构

```
index.html          页面入口
css/style.css       样式
js/indicators.js    指标计算（MACD/BOLL/RSI/KDJ/DMI/OBV，纯函数）
js/signals.js       信号引擎 + 报警管理器
js/events.js        宏观事件（内置/自定义/实时接入钩子）
js/datafeed.js      行情数据源（币安 + 离线模拟降级）
js/app.js           页面主逻辑
test/               单元测试（node:test）
```

## 测试

```bash
npm test
```

## 风险提示

本工具产生的信号仅基于技术指标规则，属于辅助参考，**不构成投资建议**。
