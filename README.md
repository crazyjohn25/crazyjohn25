# 核对台 Pro · 多维量化交易决策终端

将 19 项多周期技术指标、已排期宏观决议（美联储 FOMC、CPI、PPI、非农）、公司财报时间窗、机构资金流与实时新闻交叉核对，输出客观、讲清赔率与止损失效位的投资决策辅助。

## 监控标的与数据源

- **比特币 (`BTCUSDT`)**：Binance 现货多周期 K 线 + 浏览器 WebSocket 实时秒级推送 + 美国现货 BTC ETF 每日机构净流向（Bitbo / Farside）+ OKX 永续资金费率。
- **HYPE (`HYPEUSDT`)**：对应 `$HYPER`（Hyperliquid 主网代币 HYPE），Binance 现货实时流结合 Hyperliquid 主网完整历史 K 线。
- **SpaceX (`SPCX`)**：已于 2026 年 6 月 12 日在纳斯达克挂牌上市（IPO 发行价 `$135.00`），全量接入公开二级市场多周期 K 线、技术指标与财报日程。
- **英伟达 (`NVDA`)、AMD (`AMD`)、谷歌 (`GOOGL`)、费城半导体指数 (`^SOX`)、纳斯达克综合指数 (`^IXIC`)**：Nasdaq / Yahoo 复权多周期行情与财报风控窗口。

## 核心能力

1. **双引擎专业 K 线 + 6 大周期**：支持 `5分`、`15分`、`1小时`、`4小时`、`日线`、`周线` 秒级切换；内置 **TradingView Lightweight Charts**（滚轮缩放、拖拽平移、磁吸十字光标、主图买卖/止损线、事件标记与 `MACD / RSI / KDJ / DMI·ADX / OBV` 联动副图），并可一键切换至 **TradingView 官方原生高级图表终端**。
2. **直观正负分光谱与忠实投资建议**：`-100` 至 `+100` 五段红绿光谱直观展示多空强弱，输出分场景操作建议（现货/美股买方 vs 波段双向交易）、回踩/反弹参考区间、结构止损失效位、阶段目标位、潜在盈亏比与仓位上限。
3. **毫秒级 SWR 缓存与悬停预取**：服务端采用 Stale-While-Revalidate 并发缓存，前端支持悬停预加载与本地秒切。

## 本地运行与测试

```bash
npm install
npm run dev
```

开发地址：`http://127.0.0.1:8766`（Python 双栈服务仍可通过 `python3 marketdesk/server.py` 在 `http://127.0.0.1:8765` 启动）。

```bash
npm run test:web
python3 -m unittest marketdesk.tests.test_engine
```
