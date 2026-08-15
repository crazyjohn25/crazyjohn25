/**
 * 新闻/事件解读引擎（规则驱动，纯函数）
 * 1. classifyScope：把信息归类为"宏观（国家层面）"或"微观（公司/行业层面）"
 * 2. interpret：给出 利好/利空/中性 判断、影响对象、原因、需要规避的风险
 */

/** 宏观关键词（国家层面：货币政策、宏观数据、地缘、大宗） */
const MACRO_WORDS = [
  'fed', 'fomc', 'powell', 'rate cut', 'rate hike', 'interest rate', 'inflation',
  'cpi', 'ppi', 'nonfarm', 'payroll', 'unemployment', 'gdp', 'pmi', 'treasury',
  'tariff', 'central bank', 'ecb', 'boj', 'war', 'iran', 'israel', 'russia',
  'ukraine', 'sanction', 'geopolit', 'opec', 'crude', 'brent', 'wti',
  '美联储', '加息', '降息', '通胀', '非农', '失业率', '关税', '战争', '制裁',
  '地缘', '原油', '油价', '国债', '央行', '利率',
];

/**
 * 解读规则表：按优先级匹配，先命中先用
 * bias: bullish利好 / bearish利空 / neutral中性
 */
const RULES = [
  {
    words: ['rate cut', 'cuts rates', 'dovish', '降息', '宽松'],
    scope: 'macro', bias: 'bullish', target: '风险资产（加密/股票）',
    reason: '降息释放流动性、降低资金成本，风险资产估值抬升，历史上降息周期初期加密与成长股表现居前',
    risk: '若因经济衰退被迫降息，"衰退交易"可能压过流动性利好；注意首次降息后的高波动',
  },
  {
    words: ['rate hike', 'hikes rates', 'hawkish', '加息', '鹰派', '紧缩'],
    scope: 'macro', bias: 'bearish', target: '风险资产（加密/股票）',
    reason: '加息收紧流动性、抬升无风险利率，高估值资产折现压力增大，杠杆资金被迫去化',
    risk: '高杠杆仓位在流动性收缩期回撤会被放大，应降低杠杆、预留保证金，避免追高',
  },
  {
    words: ['inflation rises', 'cpi beats', 'cpi higher', 'hot cpi', '通胀超预期', '通胀回升', 'cpi超'],
    scope: 'macro', bias: 'bearish', target: '风险资产',
    reason: '通胀超预期会推迟降息预期、抬升实际利率，压制风险偏好',
    risk: '数据公布前后波动剧烈，避免在CPI/非农发布时点重仓短线单',
  },
  {
    words: ['inflation cools', 'cpi lower', 'inflation falls', '通胀回落', '通胀降温'],
    scope: 'macro', bias: 'bullish', target: '风险资产',
    reason: '通胀降温强化降息预期，实际利率下行利好高估值资产',
    risk: '单月数据不构成趋势，若后续数据反复，行情可能回吐',
  },
  {
    words: ['nonfarm', 'payroll', 'unemployment', '非农', '失业率'],
    scope: 'macro', bias: 'neutral', target: '全市场',
    reason: '就业数据强弱直接影响美联储政策路径：过强→紧缩担忧，过弱→衰退担忧，市场按"金发女孩"区间定价',
    risk: '非农是月度波动之王，发布瞬间价差与插针频繁，短线仓位应提前减仓或设好止损',
  },
  {
    words: ['war', 'strike', 'attack', 'iran', 'missile', '战争', '袭击', '开战', '军事'],
    scope: 'macro', bias: 'bearish', target: '风险资产（利好原油/黄金）',
    reason: '地缘冲突推升避险情绪，资金流向黄金、美元与原油，风险资产短线承压',
    risk: '冲突消息真假难辨、反复拉锯，避免追跌杀涨；若局势缓和行情会V型修复',
  },
  {
    words: ['sanction', '制裁', 'tariff', '关税'],
    scope: 'macro', bias: 'bearish', target: '全球贸易/风险资产',
    reason: '制裁与关税推升供应链成本与通胀预期，压制企业盈利与风险偏好',
    risk: '政策类消息常有谈判反复，注意消息面反转风险',
  },
  {
    words: ['opec', 'oil surge', 'crude surge', 'brent', '油价上涨', '原油上涨', '减产'],
    scope: 'macro', bias: 'bearish', target: '风险资产（利好能源股）',
    reason: '油价上行加剧通胀粘性、推迟降息，对非能源风险资产偏空，能源板块受益',
    risk: '油价与地缘高度联动，波动传导到加密市场通常有滞后，勿机械对应',
  },
  {
    words: ['etf approval', 'etf approved', 'etf inflow', 'etf批准', 'etf净流入', '现货etf'],
    scope: 'micro', bias: 'bullish', target: '对应加密资产',
    reason: 'ETF获批/净流入代表合规增量资金入场，改善供需结构与流动性深度',
    risk: 'ETF资金流向可能反转，连续净流出时利好逻辑失效',
  },
  {
    words: ['microstrategy', 'saylor', 'strategy buys', '微策略', '增持比特币', 'mstr'],
    scope: 'micro', bias: 'bullish', target: 'BTC / MSTR',
    reason: 'MicroStrategy（微策略）增持是最强的机构持续买盘信号之一，提振市场信心并减少流通盘',
    risk: 'MSTR高溢价+可转债杠杆结构脆弱：若BTC深跌引发其融资受阻，可能形成负反馈抛压，需跟踪其NAV溢价',
  },
  {
    words: ['hack', 'exploit', 'stolen', 'breach', '黑客', '被盗', '攻击事件', '漏洞'],
    scope: 'micro', bias: 'bearish', target: '涉事项目/交易所及板块',
    reason: '安全事件直接造成资产损失并打击板块信任，涉事代币与关联DeFi协议通常急跌',
    risk: '被盗资产抛售可能持续数周，反弹接飞刀风险高；检查自己资产是否有关联敞口',
  },
  {
    words: ['sec sues', 'lawsuit', 'sec charges', 'investigation', '起诉', '监管调查', '处罚'],
    scope: 'micro', bias: 'bearish', target: '涉事公司/代币',
    reason: '监管诉讼带来退市、罚款与合规成本的不确定性，机构资金会先行回避',
    risk: '诉讼周期长、消息反复，和解或胜诉时可能暴力反弹，勿裸空',
  },
  {
    words: ['earnings beat', 'beats estimates', 'raises guidance', '财报超预期', '上调指引', '业绩超'],
    scope: 'micro', bias: 'bullish', target: '涉事公司及产业链',
    reason: '业绩与指引超预期验证行业景气度，通常带动同产业链联动上涨',
    risk: '"利好出尽"：若股价已提前大涨，财报日可能高开低走',
  },
  {
    words: ['earnings miss', 'cuts guidance', 'profit warning', '财报不及', '下调指引', '业绩爆雷'],
    scope: 'micro', bias: 'bearish', target: '涉事公司及产业链',
    reason: '业绩不及预期打击板块景气度预期，产业链公司普遍连带承压',
    risk: '单一公司爆雷未必代表行业，区分个体经营问题与行业性拐点',
  },
  {
    words: ['liquidat', 'bankrupt', '清算', '破产', '爆仓'],
    scope: 'micro', bias: 'bearish', target: '相关资产',
    reason: '大规模清算/破产引发连环抛售与流动性挤兑',
    risk: '连环清算期间价格失真、插针频繁，杠杆单极易被扫损',
  },
  {
    words: ['all-time high', 'ath', 'surge', 'rally', '新高', '暴涨', '大涨'],
    scope: 'micro', bias: 'bullish', target: '相关资产',
    reason: '价格突破新高说明买方力量占优，趋势交易者视为顺势信号',
    risk: '追高需设好移动止损；新高附近获利盘抛压大，警惕假突破',
  },
  {
    words: ['crash', 'plunge', 'dump', '暴跌', '大跌', '闪崩'],
    scope: 'micro', bias: 'bearish', target: '相关资产',
    reason: '急跌通常伴随杠杆清算与恐慌盘，短期内下跌自我强化',
    risk: '下跌中段勿急于抄底，等待缩量企稳与结构修复信号',
  },
];

/** 判断信息属于宏观还是微观 */
export function classifyScope(title) {
  const t = String(title).toLowerCase();
  // 先按规则表的scope（规则更精确）
  for (const r of RULES) {
    if (r.words.some((w) => t.includes(w))) return r.scope;
  }
  if (MACRO_WORDS.some((w) => t.includes(w))) return 'macro';
  return 'micro';
}

/**
 * 解读一条信息
 * @returns {{scope, bias, biasLabel, target, reason, risk} | 中性默认}
 */
export function interpret(title) {
  const t = String(title).toLowerCase();
  for (const r of RULES) {
    if (r.words.some((w) => t.includes(w))) {
      return {
        scope: r.scope,
        bias: r.bias,
        biasLabel: r.bias === 'bullish' ? '利好' : r.bias === 'bearish' ? '利空' : '中性',
        target: r.target,
        reason: r.reason,
        risk: r.risk,
      };
    }
  }
  const scope = classifyScope(title);
  return {
    scope,
    bias: 'neutral',
    biasLabel: '中性',
    target: scope === 'macro' ? '全市场' : '相关标的',
    reason: '未命中明确的多空规则，属于信息性内容，需结合上下文与价格反应判断',
    risk: '对模糊消息保持观望，等待市场用成交量与方向投票后再行动',
  };
}
