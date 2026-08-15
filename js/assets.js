/**
 * 资产信息模块：每个交易对的介绍、类别与关键要点
 */

export const ASSET_INFO = {
  BTCUSDT: {
    name: '比特币 Bitcoin',
    cn: 'BTC',
    category: '加密 · 数字黄金',
    desc: '市值最大的加密资产，总量2100万枚恒定。机构配置通道（现货ETF、MicroStrategy等上市公司财库）使其与宏观流动性高度联动。',
    watch: '美联储利率路径、ETF资金流、MSTR增持、减半周期、链上巨鲸动向',
  },
  ETHUSDT: {
    name: '以太坊 Ethereum',
    cn: 'ETH',
    category: '加密 · 智能合约平台',
    desc: '最大的智能合约公链，DeFi/稳定币/RWA的主要结算层。质押收益+燃烧机制使其兼具"科技股+债券"属性。',
    watch: 'ETF资金流、L2生态、质押率、Gas消耗、基金会卖币',
  },
  SOLUSDT: {
    name: 'Solana',
    cn: 'SOL',
    category: '加密 · 高性能公链',
    desc: '高TPS低费用的单体链，Meme/DePIN/支付叙事的主要载体，散户活跃度最高的公链之一。',
    watch: '链上活跃度、Meme热度、FTX解锁抛压、网络稳定性',
  },
  BNBUSDT: {
    name: 'BNB',
    cn: 'BNB',
    category: '加密 · 交易所平台币',
    desc: '币安生态核心资产，兼具交易费折扣、Launchpad、BSC链Gas三重价值捕获。',
    watch: '币安Launchpad活动、BSC链数据、监管动态、季度销毁',
  },
  HYPE: {
    name: 'Hyperliquid',
    cn: 'HYPE',
    category: '加密 · 链上永续DEX',
    desc: '高性能链上永续合约交易所的代币，收入回购模型，交易员向链上迁移的直接受益标的。',
    watch: '平台交易量/未平仓量、回购规模、巨鲸开仓动向、上新速度',
  },
  NDX: {
    name: '纳斯达克100',
    cn: 'NDX',
    category: '美股 · 科技指数',
    desc: '美国100家最大非金融科技股指数，AI叙事的核心载体（英伟达/微软/苹果/谷歌权重高）。',
    watch: '美联储政策、AI资本开支、巨头财报、10年期美债收益率',
  },
  AAPL: {
    name: '苹果 Apple',
    cn: 'AAPL',
    category: '美股 · 消费电子',
    desc: '全球市值最高的公司之一，iPhone+服务双引擎，AI终端（Apple Intelligence）是主要叙事。',
    watch: 'iPhone销量、服务收入增速、AI功能落地、中国市场',
  },
  NVDA: {
    name: '英伟达 NVIDIA',
    cn: 'NVDA',
    category: '美股 · AI算力',
    desc: 'AI GPU绝对龙头，数据中心业务驱动，全球AI资本开支的最大受益者。',
    watch: '数据中心营收、GB系列出货、超大厂资本开支指引、出口管制',
  },
  TSLA: {
    name: '特斯拉 Tesla',
    cn: 'TSLA',
    category: '美股 · 电动车/机器人',
    desc: '电动车+自动驾驶+机器人叙事，波动率最高的 mega-cap，马斯克言论敏感。',
    watch: '交付量、FSD进展、Robotaxi、毛利率、马斯克动向',
  },
  MSTR: {
    name: 'MicroStrategy（Strategy）',
    cn: 'MSTR',
    category: '美股 · BTC杠杆代理',
    desc: '上市公司中最大的比特币持有者，通过可转债+增发持续增持BTC，股价相当于带杠杆的BTC敞口。',
    watch: 'BTC价格、NAV溢价率、可转债发行、Saylor增持公告',
  },
};

export function getAssetInfo(symbolId) {
  return (
    ASSET_INFO[symbolId] || {
      name: symbolId,
      cn: symbolId,
      category: '-',
      desc: '暂无介绍',
      watch: '-',
    }
  );
}
