# K线智能分析终端

基于 TradingView 开源图表库 [lightweight-charts](https://github.com/tradingview/lightweight-charts) 的 K 线分析终端，专注 **BTC/ETH/SOL/BNB/HYPE**。

### v12 核心（当前版本）

1. **开仓账本**：每笔开仓都进入不可变账本（`js/wallet.js` v4），保存信号ID、评分、计划、费用、事件流；仓位列表只是账本中 open 的子集，不再丢失历史。
2. **算法开仓**：只在 **强烈 + 高确定性**（|评分|≥3.5、盈亏比≥2、置信度≥0.85）时自动开仓；打开网页不会自动开仓，后台监控只提醒。
3. **已删除 Serenity**：移除 Serenity 跟踪、公司资料与相关测试。
4. **每日 23:00 基本面日报**：打开页面不自动生成报告；每晚 23:00（UTC+8）自动拉取 30m/1h/4h/日线 + Sosovalue + 策略1/2 生成日报并推送。
5. **Sosovalue 融合**：清算热力图 / 资金费率 / 交易量 / 新闻侧数据通过公共代理尽力解析；无数据时降级为本地清算簇与资金费率钩子。
6. **策略1（体制→位置→确认→执行）**：周线趋势 + 宏观（美联储/美元）+ 资金费率拥挤度 → Volume Profile 节点 / VWAP / 前高前低 / 清算簇 → CVD/OI 是否同向 → 突破放量收盘 / 回踩缩量 / 单笔风险 0.5%–2%、盈亏比至少 2:1。
7. **策略2（指标科学分组）**：EMA / MACD / RSI / SUPER / SAR / KDJ / OBV / DMI 按「趋势 / 动量 / 震荡 / 量能」四组独立打分，输出多维趋势报告。
8. **副图指标**：在 RSI/KDJ/STOCH/WAE/DMI/OBV 基础上新增 SAR / SUPER / CVD。

### v11 布局与强烈信号

- **整页重排**：左侧纯K线工作区（报价条 + 主图/MACD/副图），右侧情报栏（强烈信号存档置顶 + Tab）。新闻、KOL 不再叠在蜡烛上。
- **K线减负**：宏观事件默认不画在图上；若在新闻Tab打开「圆点标注」，也只画圆点、不写标题。买卖箭头仅显示强度≥3。摆动点默认关闭。
- **KOL 雷达独立Tab**：覆盖 BTC/ETH/SOL/BNB/HYPE；默认监控清单按 [x.com/johnliu409](https://x.com/johnliu409) 一类关注风格整理，设置里可追加 X 账号。Telegram 公开频道（用户名或 t.me 链接）走 rsshub；社群链接稍后填入即可。
- **只给强烈信号**：|评分|≥3 才存档、提醒、自动开仓；同一品种+策略+方向 12 小时去重，避免刷屏。取消「每天至少一单」。
- **模拟盘最高 30 倍**：杠杆 10–30x，按强烈信号强度分档；开平仓按币安 USDT 永续普通用户 taker **0.05%/边** + 资金费 **0.01%/8h** 计成本。

### v10 重构

- **已删除**：Polymarket 5分钟全部功能、旧策略回放式回测、每小时收益
- **浅色主题**：全站浅色背景重设计，图表同步浅色
- **资产信息**：每个交易对（BTC/ETH/SOL/BNB/HYPE/NDX/AAPL/NVDA/TSLA/MSTR）附介绍、类别与重点关注要点
- **做市商Gamma环境**：Deribit公开期权数据，Black-Scholes计算GEX，正Gamma（震荡市）/负Gamma（趋势市）判断 + Call Wall/Put Wall 关键位（仅BTC/ETH）
- **提醒系统**：页面弹窗+提示音+浏览器通知+**Telegram Bot/邮箱Webhook**（后台设置配置，支持测试发送）
- **AI交易复盘Tab**：只记录模拟钱包真实开仓（无开仓不记录），时间升序全明细（开平仓时间/价格/杠杆/原因/ROI）+ 基于真实结果的反思
- **新闻源**：金十数据、ChainCatcher（链捕手）、The Block/CoinDesk/吴说/Foresight/PANews/AP/Yahoo/CoinTelegraph/Decrypt 等12+源

## 本地部署

```bash
# 1. 拉取代码
git clone https://github.com/crazyjohn25/crazyjohn25.git
cd crazyjohn25
git checkout cursor/tradingview-macro-signals-bd5c

# 2. 启动（任选其一）
./start.sh              # Mac/Linux，默认8080端口
start.bat               # Windows 双击或命令行运行
npm start               # 或 python3 -m http.server 8080

# 3. 浏览器打开
http://localhost:8080
```

纯静态站点，无需Node依赖、无需构建。所有数据（钱包/设置/报告/复盘）存在浏览器localStorage，本地部署即用。

### 后台设置（页面右上角 ⚙ 设置）

- **Telegram提醒**：[@BotFather](https://t.me/BotFather) 创建bot拿token → 给你的bot发条消息 → 访问 `https://api.telegram.org/bot<token>/getUpdates` 拿chat_id → 填入设置。重大信号/开平仓/每日复盘自动推送。
- **邮箱提醒**：填入你的webhook地址（IFTTT/Zapier/自建服务），系统POST `{subject, text}`。
- **钱包初始资金**：默认$10000，可自定义。
- **X关注列表**：填入逗号分隔的X账号（参考你的关注列表），KOL雷达会纳入监控。
- **Telegram频道**：默认 PANews/Foresight，可自行追加公开频道名。

- 行情数据默认来自**币安公开API**（REST历史K线 + WebSocket实时推送，无需API Key）。
- 若网络无法访问币安，自动降级为**本地模拟行情**离线演示，状态栏会显示"离线模式"。

## 功能说明

### 图表布局

- 主图：K线 + 布林带 + 成交量 + 高强度买卖箭头（新闻默认不叠在图上，避免和K线挤在一起）
- 副图1：**MACD(12,26,9)**（DIF/DEA/柱状图）
- 副图2：可切换 RSI / KDJ / STOCH / WAE / DMI / OBV / SAR / SUPER / CVD
- 三图时间轴联动缩放

### 买卖信号规则（多指标共振）

单个K线上满足条件各计1分，**总分 ≥ 2 才触发信号**；信号仅对**已收盘K线**报警，避免盘中反复触发。阈值可在 `js/signals.js` 中调整。

### 宏观事件与新闻

- 真实新闻：`js/news.js` 通过 rss2json 抓取 The Block / CoinDesk / 吴说区块链 / AP News 等，按当前品种关键词 + 宏观分类过滤。
- 内置示例事件位于 `js/events.js`；侧栏可添加自定义事件，保存于浏览器 localStorage。

## 目录结构

```
index.html          页面入口
css/style.css       样式
js/indicators.js    指标计算（MACD/BOLL/RSI/KDJ/DMI/OBV/SAR/SUPER/CVD/VP/清算簇，纯函数）
js/signals.js       信号引擎 + 报警管理器
js/archive.js       强烈信号存档（去重、只收录共振信号）
js/radar.js         KOL/X/Telegram 开仓信号雷达
js/sosovalue.js     Sosovalue 清算/资金/交易量/新闻侧融合
js/strategies-report.js  策略1（体制/位置/确认/执行）与策略2（指标分组）
js/volume.js        每小时交易量统计与横向对比（纯函数）
js/anomaly.js       异常交易检测（量价异动统计 + 鲸鱼单缓存 + 外部源钩子）
js/news.js          真实宏观新闻抓取与相关性过滤
js/events.js        宏观事件（内置/自定义）
js/interpret.js     新闻宏观/微观归类 + 利好利空解读引擎
js/review.js        建议复盘与自适应权重
js/wallet.js        模拟钱包 v4（不可变开仓账本、最高30x、币安费率）
js/report.js        每日23点基本面日报
js/stocks.js        股票行情（Yahoo chart/quote/公司新闻 + CORS代理链 + 快照降级）
js/datafeed.js      行情数据源（Binance + Hyperliquid + 股票 + 离线模拟降级）
js/app.js           页面主逻辑
data/stocks-snapshot.json  股票日线快照（构建时生成，离线兜底）
test/               单元测试（node:test）
```

## 测试

```bash
npm test
```

## 风险提示

本工具产生的信号仅基于技术指标规则，属于辅助参考，**不构成投资建议**。30x 杠杆下强平仍然很快，模拟钱包绩效仅供策略验证。Sosovalue / X / Telegram 直连需付费 API，当前为公开通道聚合，不是完整数据流。
