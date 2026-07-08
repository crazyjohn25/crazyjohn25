/**
 * Serenity 推荐个股的公司基本面数据集（人工整理的真实资料，非实时）
 * 字段说明：
 *   name/cn      公司英文/中文名
 *   desc         主营业务
 *   rank         该细分赛道的定位与排名
 *   peers        主要竞品公司
 *   pe/pb/mcap   市盈率/市净率/市值（参考值，亏损公司PE记为'亏损'或'N/A'）
 *   financials   最近财报要点
 *   bull         我方买入理由（独立于Serenity的正向逻辑）
 *   challenge    对Serenity推荐逻辑的质疑/反方观点
 * 实时价格与52周高低由 stocks.js 的 chart meta 叠加，PE/PB等静态字段为参考。
 */

export const COMPANIES = {
  AXTI: {
    name: 'AXT, Inc.', cn: '博升光电/AXT',
    desc: '半导体衬底材料商，主营磷化铟(InP)、砷化镓(GaAs)、锗单晶衬底，是AI光互连InP衬底的核心供应商。',
    rank: 'InP衬底全球第一梯队（与住友电工、JX金属并列），西方阵营中稀缺的InP产能提供方。',
    peers: ['住友电工 Sumitomo', 'JX金属', 'IQE plc', '云南锗业'],
    pe: '亏损', pb: '1.5x', mcap: '~25亿美元',
    financials: '营收季度环比回升，毛利率受产能利用率拖累；子公司在中国有稀有金属提纯垂直整合；2026Q2财报7/30。',
    bull: 'AI光模块从800G向1.6T演进使InP需求结构性上行，衬底是最上游、扩产周期最长的环节，AXT具备西方产能稀缺性溢价。',
    challenge: 'AXT长期微利甚至亏损、现金流薄弱，InP需求兑现节奏慢于市场想象；中国出口管制与地缘风险可能反噬其中国子公司估值——Serenity的"垄断定价权"尚未体现在报表上。',
  },
  'SIVE.ST': {
    name: 'Sivers Semiconductors', cn: 'Sivers半导体',
    desc: '瑞典光子学与毫米波公司，CW（连续波）激光器、硅光子集成，服务光通信与5G/6G。',
    rank: 'CW激光器细分稀缺标的，体量小但卡位光源上游。',
    peers: ['Coherent', 'Lumentum', 'POET Technologies'],
    pe: '亏损', pb: '2.0x', mcap: '~3亿美元',
    financials: '营收基数小、持续亏损，依赖光子部门订单放量；现金消耗需关注增发风险。',
    bull: 'CPO（共封装光学）趋势下外置CW光源需求爆发，Sivers是少数能供货的独立光源厂，具备被并购价值。',
    challenge: '公司规模过小、盈利遥远，"收购链"叙事高度依赖假设；一旦大厂自研光源或增发摊薄，逻辑崩塌——这是典型高赔率高风险的题材股，不宜重仓。',
  },
  AAOI: {
    name: 'Applied Optoelectronics', cn: 'AAOI/新飞通',
    desc: '光模块与光器件厂商，数据中心光收发模块、CATV宽带接入设备，垂直整合激光器芯片。',
    rank: '数据中心光模块第二梯队，激光器自产是差异化；北美超大厂供应链成员。',
    peers: ['Coherent', 'Lumentum', '中际旭创 InnoLight', 'Fabrinet'],
    pe: '亏损', pb: '3.5x', mcap: '~40亿美元',
    financials: 'Serenity曾在卖方一致预期+14%时喊出+55%营收增速，实际约+58%，股价两日大涨；订单能见度改善但毛利波动大。',
    bull: '自有激光器芯片+超大厂800G/1.6T订单放量，营收拐点已被最新财报验证，戴维斯双击仍在途中。',
    challenge: '客户高度集中（少数超大厂），议价权弱、毛利率历史性偏低；股价已price-in高增长，若单季不及预期回撤剧烈——追高需严格止损。',
  },
  LITE: {
    name: 'Lumentum Holdings', cn: 'Lumentum',
    desc: '光模块与激光器龙头，数据中心光收发、3D传感、工业激光，自有InP晶圆厂。',
    rank: '数据中心光学双寡头之一（与Coherent并列），产业链地位稳固。',
    peers: ['Coherent', 'Fabrinet', '中际旭创 InnoLight', 'Marvell'],
    pe: '35x(预期)', pb: '6x', mcap: '~200亿美元',
    financials: '云端光模块营收强劲增长，电信业务企稳；InP自有产能是长期壁垒。',
    bull: '大市值、有自有InP产能，兼具确定性与AI弹性，是"卡脖子"叙事里少数可重仓的蓝筹。',
    challenge: '估值已不便宜，AI光模块竞争加剧（中系厂商价格战），若资本开支放缓则增速回落；相对小票弹性有限。',
  },
  COHR: {
    name: 'Coherent Corp', cn: 'Coherent/相干',
    desc: '光学与激光巨头（II-VI收购Coherent后更名），光通信、工业激光、半导体材料(SiC/GaAs)。',
    rank: '光学环节全球龙头，垂直整合从材料到模块，规模最大。',
    peers: ['Lumentum', 'MKS Instruments', 'IPG Photonics'],
    pe: '30x(预期)', pb: '3x', mcap: '~500亿美元',
    financials: '数据中心收发模块高速增长，债务高企但在去杠杆；碳化硅业务提供第二曲线。',
    bull: '光通信+材料双引擎，规模效应与专利壁垒深厚，AI光学放量的核心受益龙头。',
    challenge: '历史并购留下的高负债与整合风险；业务庞杂、非AI部分拖累增速；估值反映了较高预期。',
  },
  TSEM: {
    name: 'Tower Semiconductor', cn: 'Tower/高塔',
    desc: '以色列特色工艺晶圆代工，模拟、射频、电源、硅光子(SiPho)平台。',
    rank: '特色工艺代工全球前列，硅光平台是AI光学差异化卡位。',
    peers: ['GlobalFoundries', '联电 UMC', '中芯国际 SMIC'],
    pe: '20x', pb: '1.8x', mcap: '~250亿美元',
    financials: '产能利用率回升带动毛利改善，硅光与SiGe订单增长；财务稳健、现金流为正。',
    bull: '硅光子代工是CPO落地的关键产能，Tower卡位好且已盈利，风险收益比优于纯题材股。',
    challenge: '特色代工客户分散、单一AI叙事占比不高，成长弹性不如纯光模块；地缘（以色列局势）带来运营不确定性。',
  },
  NBIS: {
    name: 'Nebius Group', cn: 'Nebius',
    desc: '欧洲AI云算力商（原Yandex国际业务分拆），提供GPU云、AI基础设施。',
    rank: 'AI Neocloud新势力，欧洲布局，规模小于CoreWeave但增速快。',
    peers: ['CoreWeave', 'Crusoe', 'Lambda', 'Oracle OCI'],
    pe: '亏损', pb: '4x', mcap: '~200亿美元',
    financials: '算力收入高速增长但重资产、资本开支巨大、现金流为负；持有多项资产（含ClickHouse等股权）。',
    bull: 'AI算力需求外溢到Neocloud，Nebius有欧洲合规优势与充裕融资，属于GPU租赁景气周期的高弹性标的。',
    challenge: 'Neocloud商业模式重资产、依赖持续融资，GPU折旧与利用率风险大；一旦算力供给过剩或大厂自建，租赁价格战会击穿盈利模型。',
  },
  'IQE.L': {
    name: 'IQE plc', cn: 'IQE',
    desc: '英国化合物半导体外延片(epiwafer)龙头，为射频、光子、传感提供外延材料。',
    rank: '外延片代工全球龙头，InP/GaAs外延产业链上游。',
    peers: ['AXT', '住友化学', 'Win Semiconductors'],
    pe: '亏损', pb: '1.2x', mcap: '~3亿英镑',
    financials: '营收受消费电子周期拖累、持续亏损，正剥离资产聚焦主业；AI光子外延是潜在拐点。',
    bull: '外延片是InP产业链承上启下的卡位，估值极低（PB约1倍），AI光子需求若起量则弹性巨大。',
    challenge: '主业仍受手机射频周期拖累、盈利能力弱，AI光子占比尚小；小市值+英股流动性差，题材兑现前波动剧烈。',
  },
  POET: {
    name: 'POET Technologies', cn: 'POET',
    desc: '加拿大光子集成公司，POET Optical Interposer光引擎平台，用于AI光互连。',
    rank: '光引擎/光子集成新锐，与多家封装厂合作，尚处商业化早期。',
    peers: ['Sivers', 'Lumentum', 'Broadcom(光引擎)'],
    pe: '亏损', pb: '3x', mcap: '~5亿美元',
    financials: '营收极小、持续亏损，靠融资与合作预付款推进量产；订单指引是关键催化。',
    bull: '光引擎方案若被采用可切入CPO核心，属于极高赔率的期权型标的。',
    challenge: '商业化落地反复延期、报表尚无实质营收，稀释与执行风险高；仅适合极小仓位博弈，不能当作确定性投资。',
  },
  MU: {
    name: 'Micron Technology', cn: '美光',
    desc: '存储巨头，DRAM、NAND闪存，HBM高带宽存储是AI算力关键瓶颈。',
    rank: '全球DRAM三强之一（与三星、SK海力士），HBM是AI核心受益点。',
    peers: ['三星电子 Samsung', 'SK海力士 SK Hynix'],
    pe: '15x', pb: '2.5x', mcap: '~1万亿美元级',
    financials: 'HBM供不应求、订单已售罄至次年，存储周期上行推动营收利润大幅增长。',
    bull: 'HBM是继GPU之后最确定的AI瓶颈，美光份额提升+存储涨价周期，业绩与估值双升，且是可重仓的大盘蓝筹。',
    challenge: '存储是强周期品种，价格见顶回落时业绩弹性反向；HBM竞争加剧（海力士领先、三星追赶）可能压缩份额与利润率。',
  },
  ASX: {
    name: 'ASE Technology', cn: '日月光',
    desc: '全球最大封装测试(OSAT)厂商，先进封装、SiP系统级封装。',
    rank: '封测全球第一，先进封装(FOCoS/2.5D)受益AI。',
    peers: ['Amkor', '长电科技 JCET', '力成科技'],
    pe: '18x', pb: '2.2x', mcap: '~400亿美元',
    financials: '先进封装订单饱满，稼动率高；传统封测受消费电子拖累但整体稳健盈利。',
    bull: 'AI芯片先进封装需求外溢，日月光龙头地位与产能规模确保订单，估值合理、分红稳定。',
    challenge: 'CoWoS等最核心先进封装被台积电把持，OSAT吃的是外溢需求、弹性次之；封测毛利率天花板低。',
  },
  JBL: {
    name: 'Jabil Inc', cn: '捷普',
    desc: '电子制造服务(EMS)巨头，AI服务器、云基础设施、光模块组装。',
    rank: 'EMS全球前三，AI服务器与数据中心是增长引擎。',
    peers: ['富士康 Foxconn', 'Flex', 'Celestica'],
    pe: '20x', pb: '高(股本回购致净资产低)', mcap: '~450亿美元',
    financials: 'AI/云板块高增长，公司持续大额回购推升EPS；整体营收结构向高价值转移。',
    bull: 'AI服务器代工放量+持续回购，EPS复合增长确定性高，是稳健的AI"卖铲人"。',
    challenge: 'EMS本质是低毛利代工、议价权弱；营收依赖少数大客户，消费电子板块拖累仍在。',
  },
  VICR: {
    name: 'Vicor Corp', cn: 'Vicor',
    desc: '高密度电源模块厂商，为AI GPU提供垂直供电(VPD)方案。',
    rank: '高密度供电利基龙头，技术领先但体量小。',
    peers: ['Monolithic Power MPWR', 'Infineon', 'Delta 台达'],
    pe: '50x+', pb: '4x', mcap: '~30亿美元',
    financials: '受GPU供电升级驱动订单回升，专利诉讼胜诉带来授权金潜力；毛利率较高。',
    bull: 'GPU功耗飙升使近芯片供电成为新战场，Vicor的VPD技术卡位好，专利授权是额外期权。',
    challenge: '客户导入进度慢、营收波动大，估值偏高；MPS等大厂在供电领域竞争凶猛，Vicor份额易被蚕食。',
  },
  GFS: {
    name: 'GlobalFoundries', cn: '格芯',
    desc: '特色工艺晶圆代工，汽车、物联网、射频、电源管理。',
    rank: '特色代工全球前三，非先进制程路线。',
    peers: ['台积电 TSMC', '联电 UMC', 'Tower'],
    pe: '25x', pb: '2x', mcap: '~350亿美元',
    financials: '汽车与工业需求企稳，长期协议(LTA)锁定产能与价格；盈利稳定。',
    bull: '特色工艺现金流稳、有政府补贴(美国本土产能)，AI外围（电源、射频）需求提供边际增量。',
    challenge: '不做先进制程，AI核心红利吃不到，只是"AI暴露盘"外围；成长性平庸、估值不算便宜。',
  },
  FN: {
    name: 'Fabrinet', cn: 'Fabrinet',
    desc: '泰国精密光学与电子制造代工，光模块的主要代工厂。',
    rank: '光学制造代工全球龙头，Lumentum/Coherent/英伟达光学供应链核心代工方。',
    peers: ['Jabil', 'Sanmina', 'Benchmark'],
    pe: '25x', pb: '5x', mcap: '~150亿美元',
    financials: '数据中心光模块代工订单强劲，营收创新高、执行稳健、现金流优异。',
    bull: '不押注单一技术路线，谁的光模块放量Fabrinet都受益，是最"旱涝保收"的光学卖铲人。',
    challenge: '代工毛利率天花板低，客户集中(英伟达/Lumentum占比高)；若客户转单或自建产能则冲击大。',
  },
  CLS: {
    name: 'Celestica', cn: 'Celestica',
    desc: 'EMS/ODM厂商，AI网络交换机、服务器硬件(HPS部门高增长)。',
    rank: 'AI网络硬件ODM领先，超大厂交换机核心供应商。',
    peers: ['Jabil', 'Flex', '富士康 Foxconn'],
    pe: '25x', pb: '6x', mcap: '~150亿美元',
    financials: 'HPS(硬件平台方案)部门受AI网络驱动高速增长，连续上调指引、股价强势。',
    bull: 'AI数据中心网络(800G交换机)放量，Celestica绑定超大厂订单，ODM附加值高于纯EMS。',
    challenge: '股价已大幅上涨price-in高预期，客户高度集中；一旦超大厂资本开支节奏调整，高估值回撤风险大。',
  },
  AMKR: {
    name: 'Amkor Technology', cn: '安靠',
    desc: '全球第二大封装测试(OSAT)厂，先进封装、汽车与AI芯片封测。',
    rank: '封测全球第二(仅次日月光)，美国本土产能布局受政策支持。',
    peers: ['日月光 ASE', '长电科技 JCET', '力成'],
    pe: '18x', pb: '1.8x', mcap: '~70亿美元',
    financials: '先进封装订单回暖，亚利桑那新厂受CHIPS法案支持；消费电子板块仍偏弱。',
    bull: 'AI先进封装需求+美国本土产能政策红利，Amkor作为西方OSAT有稀缺性与估值修复空间。',
    challenge: '核心CoWoS仍被台积电掌控，OSAT吃外溢；客户与产品周期性强，毛利率偏低。',
  },
  MRVL: {
    name: 'Marvell Technology', cn: '迈威尔',
    desc: '定制芯片(ASIC)、数据中心网络、光DSP、存储控制器。',
    rank: '定制AI芯片与光DSP第二梯队(次于博通)，超大厂ASIC核心合作方。',
    peers: ['Broadcom 博通', 'Credo', 'Alchip 世芯'],
    pe: '35x(预期)', pb: '4x', mcap: '~1500亿美元',
    financials: '定制AI芯片(如亚马逊Trainium)与光DSP营收高增长，数据中心占比持续提升。',
    bull: '定制ASIC是超大厂降本的确定趋势，Marvell是仅次博通的第二选择，光DSP绑定光模块放量，双重AI杠杆。',
    challenge: '博通在定制芯片领域优势碾压，Marvell份额与议价权受压；非数据中心业务(消费/运营商)拖累，估值已较高。',
  },
};

/** 取公司资料，未收录时返回最小占位 */
export function getCompany(ticker) {
  return (
    COMPANIES[ticker] || {
      name: ticker, cn: ticker, desc: '暂无详细资料',
      rank: '-', peers: [], pe: '-', pb: '-', mcap: '-',
      financials: '-', bull: '-', challenge: '-',
    }
  );
}
