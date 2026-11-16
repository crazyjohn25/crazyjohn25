const state = {
  asset: "btc",
  horizon: "swing",
  osc: "rsi",
  overlays: { ema: true, bb: true, st: true, vwap: false },
  hover: null,
  board: null,
  view: null,
};

const GROUPS = {
  trend: "趋势",
  momentum: "动量",
  volume: "量能",
  location: "位置",
  relative: "相对",
  summary: "摘要",
  flow: "资金",
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value === null || value === undefined || value === false) return;
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  });
  children.flat().forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return node;
}

function fmt(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function signed(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  const text = fmt(Math.abs(value), digits);
  if (value > 0) return `+${text}`;
  if (value < 0) return `-${text}`;
  return text;
}

function tone(value) {
  if (value === null || value === undefined || Math.abs(value) < 8) return "flat";
  return value > 0 ? "up" : "down";
}

function shanghai(ts) {
  if (!ts) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ts * 1000));
}

function dayKey(ts) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts * 1000));
}

async function refresh() {
  const rail = document.getElementById("rail");
  const main = document.getElementById("main");
  if (!state.board) main.replaceChildren(el("p", { class: "loading" }, "正在读取行情、日程和新闻。"));
  try {
    const [boardRes, viewRes] = await Promise.all([
      fetch("/api/board"),
      fetch(`/api/asset?id=${encodeURIComponent(state.asset)}&horizon=${encodeURIComponent(state.horizon)}`),
    ]);
    const board = await boardRes.json();
    const view = await viewRes.json();
    if (!boardRes.ok || !viewRes.ok) {
      throw new Error(view.error || board.error || "读取失败");
    }
    state.board = board;
    state.view = view;
    document.getElementById("clock").textContent = `上海时间 ${board.as_of.replace("T", " ").slice(0, 16)} · 约每分钟核对一次`;
    renderRail();
    renderMain();
  } catch (error) {
    main.replaceChildren(
      el("p", { class: "error" }, error.message || "读取失败"),
      el("button", { class: "toggle", type: "button", onclick: () => refresh() }, "重试")
    );
    rail.replaceChildren();
  }
}

function renderRail() {
  const rail = document.getElementById("rail");
  rail.replaceChildren(
    ...state.board.cards.map((card) => {
      const score = card.action_score;
      return el(
        "button",
        {
          class: `card${card.id === state.asset ? " active" : ""}`,
          type: "button",
          onclick: () => {
            if (state.asset === card.id) return;
            state.asset = card.id;
            state.hover = null;
            refresh();
          },
        },
        el(
          "div",
          { class: "card-top" },
          el("b", {}, card.name),
          el("span", { class: `score-pill ${tone(score)}` }, card.tradable ? signed(score, 0) : "—")
        ),
        el("div", { class: "muted" }, `${card.symbol} · ${card.stance_label || card.error || ""}`),
        card.price !== undefined && card.price !== null
          ? el("div", { class: "num" }, fmt(card.price, card.symbol === "^IXIC" || card.symbol === "^SOX" ? 0 : 2))
          : null
      );
    }),
    el("p", { class: "note" }, state.board.cluster.text)
  );
}

function renderMain() {
  const view = state.view;
  const main = document.getElementById("main");
  const score = view.score || { ok: false, reason: view.error };
  const parts = [
    el("section", { class: "cluster" }, el("p", { class: "summary" }, state.board.cluster.text)),
    headerBlock(view),
  ];
  if (!view.tradable || !score.ok) {
    parts.push(el("section", { class: "panel" }, el("h2", {}, "为什么没有多空分"), el("p", { class: "summary" }, score.reason || view.error || "这次没有读数。")));
  } else {
    parts.push(scoreBlock(view, score));
  }
  (view.warnings || []).forEach((warning) => parts.push(el("p", { class: "warn" }, warning)));
  if (view.candles && view.candles.length) parts.push(chartBlock(view));
  parts.push(infoBlock(view));
  if (score.ok) parts.push(signalBlock(score), adjustmentBlock(score));
  if (view.id === "btc" && view.flows) parts.push(flowBlock(view));
  parts.push(guideBlock(view.guide));
  parts.push(
    el(
      "p",
      { class: "source" },
      "行情：Yahoo Finance、Kraken。永续资金费率：OKX。比特币现货 ETF：Farside。日程：美国劳工统计局、美联储，财报日来自 Yahoo / Nasdaq。新闻：Google 新闻订阅。标题保持来源原文。这不是下单指令。"
    )
  );
  main.replaceChildren(...parts);
  if (view.candles && view.candles.length) requestAnimationFrame(() => requestAnimationFrame(draw));
}

function headerBlock(view) {
  const change = view.change_pct;
  return el(
    "div",
    { class: "head" },
    el(
      "div",
      {},
      el("p", { class: "symbol" }, `${view.symbol} · ${view.pair}`),
      el("h1", {}, view.name),
      el("p", { class: "note" }, view.note || "")
    ),
    el(
      "div",
      {},
      el("p", { class: "price" }, view.price === undefined || view.price === null ? "—" : fmt(view.price, view.digits || 2)),
      el("p", { class: tone(change === undefined || change === null ? null : change * 100) }, change === undefined || change === null ? view.session || "" : `${signed(change * 100, 2)}% · ${view.session || ""}`),
      !view.tradable
        ? el("p", { class: "note" }, "没有连续成交。")
        : view.live_bar
          ? el("p", { class: "note" }, "现价含未收盘 K 线。方向分只用已收盘的那一根。")
          : el("p", { class: "note" }, "当前最后一根 K 线已收盘。")
    )
  );
}

function scoreBlock(view, score) {
  const metrics = [
    ["方向分", score.direction_score],
    ["执行分", score.execution_score],
    ["风险分", score.risk_score],
  ];
  return el(
    "section",
    { class: "hero" },
    el(
      "div",
      { class: "action" },
      el("span", { class: "muted" }, `${score.regime_label} · 动作分`),
      el("strong", { class: tone(score.action_score) }, signed(score.action_score, 0)),
      el("span", {}, score.stance_label)
    ),
    el(
      "div",
      { class: "panel" },
      el("p", { class: "summary" }, score.summary),
      el(
        "div",
        { class: "metrics" },
        ...metrics.map(([label, value]) =>
          el(
            "div",
            { class: "metric" },
            el("span", {}, label),
            el("b", { class: label === "方向分" ? tone(value) : "" }, label === "方向分" ? signed(value, 0) : fmt(value, 0))
          )
        )
      ),
      el("p", { class: "note" }, score.invalidation ? score.invalidation.text : ""),
      el(
        "p",
        { class: "note" },
        `决策用${view.horizon_label || "日线"}，并对照${view.higher_label || "高周期"}。TVMC ${fmt(score.tvmc, 0)}。覆盖率 ${fmt((score.coverage || 0) * 100, 0)}%。`
      )
    )
  );
}

function chartBlock(view) {
  const canvas = el("canvas", { id: "chart", role: "img", "aria-label": `${view.name} K 线、均线、布林带和日程竖线` });
  canvas.addEventListener("mousemove", (event) => {
    const rect = canvas.getBoundingClientRect();
    state.hover = event.clientX - rect.left;
    draw();
  });
  canvas.addEventListener("mouseleave", () => {
    state.hover = null;
    draw();
  });
  const toggles = [
    ["ema", "EMA"],
    ["bb", "布林"],
    ["st", "Supertrend"],
    ["vwap", "VWAP"],
  ].map(([key, label]) =>
    el(
      "button",
      {
        class: "toggle",
        type: "button",
        "aria-pressed": state.overlays[key] ? "true" : "false",
        onclick: (event) => {
          state.overlays[key] = !state.overlays[key];
          event.currentTarget.setAttribute("aria-pressed", state.overlays[key] ? "true" : "false");
          draw();
        },
      },
      label
    )
  );
  const horizons = ["swing", "intraday"].map((horizon) =>
    el(
      "button",
      {
        class: "toggle",
        type: "button",
        "aria-pressed": state.horizon === horizon ? "true" : "false",
        onclick: () => {
          if (!view.tradable || state.horizon === horizon) return;
          state.horizon = horizon;
          state.hover = null;
          refresh();
        },
      },
      horizon === "swing" ? "日线波段" : view.id === "hype" ? "四小时" : "一小时"
    )
  );
  const osc = ["rsi", "macd"].map((name) =>
    el(
      "button",
      {
        class: "toggle",
        type: "button",
        "aria-pressed": state.osc === name ? "true" : "false",
        onclick: (event) => {
          state.osc = name;
          event.currentTarget.parentElement.querySelectorAll("button").forEach((button) => {
            if (button.textContent === "RSI" || button.textContent === "MACD") {
              button.setAttribute("aria-pressed", "false");
            }
          });
          event.currentTarget.setAttribute("aria-pressed", "true");
          draw();
        },
      },
      name.toUpperCase()
    )
  );
  return el(
    "section",
    { class: "panel" },
    el("div", { class: "toolbar" }, ...horizons, ...toggles, ...osc),
    el("div", { class: "chart-wrap" }, canvas),
    el(
      "div",
      { class: "legend" },
      el("span", {}, el("i", { class: "swatch", style: "background:#e0b15e" }), "EMA20"),
      el("span", {}, el("i", { class: "swatch", style: "background:#8eb4d4" }), "EMA50"),
      el("span", {}, el("i", { class: "swatch", style: "background:#8a93a0" }), "布林"),
      el("span", {}, el("i", { class: "swatch", style: "background:#d28b5c" }), "Supertrend"),
      el("span", {}, "竖线是 CPI、非农、FOMC 或财报。文字在下方时间线。")
    )
  );
}

function draw() {
  const canvas = document.getElementById("chart");
  const view = state.view;
  if (!canvas || !view || !view.candles) return;
  const candles = view.candles;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const pad = { l: 8, r: 64, t: 12, b: 22 };
  const priceH = (height - pad.t - pad.b) * 0.58;
  const volH = (height - pad.t - pad.b) * 0.14;
  const oscH = (height - pad.t - pad.b) * 0.22;
  const gap = 10;
  const priceTop = pad.t;
  const volTop = priceTop + priceH + gap;
  const oscTop = volTop + volH + gap;
  const plotW = width - pad.l - pad.r;
  const gaps = [];
  for (let i = 1; i < candles.length; i += 1) gaps.push(candles[i].t - candles[i - 1].t);
  gaps.sort((a, b) => a - b);
  const interval = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 86400;
  const lastT = candles[candles.length - 1].t;
  const upcoming = (view.events || [])
    .filter((event) => event.impact === "high" && event.t > lastT)
    .sort((a, b) => a.t - b.t)
    .slice(0, 4);
  const extra = upcoming.length ? Math.min(36, Math.ceil((upcoming[upcoming.length - 1].t - lastT) / interval)) : 0;
  const slot = plotW / (candles.length + extra);

  const highs = candles.map((bar) => bar.h);
  const lows = candles.map((bar) => bar.l);
  candles.forEach((bar) => {
    if (state.overlays.ema) {
      if (bar.ema20) highs.push(bar.ema20), lows.push(bar.ema20);
      if (bar.ema50) highs.push(bar.ema50), lows.push(bar.ema50);
    }
    if (state.overlays.bb) {
      if (bar.bb_up) highs.push(bar.bb_up);
      if (bar.bb_low) lows.push(bar.bb_low);
    }
    if (state.overlays.st && bar.supertrend) {
      highs.push(bar.supertrend);
      lows.push(bar.supertrend);
    }
  });
  let min = Math.min(...lows);
  let max = Math.max(...highs);
  const padY = (max - min) * 0.06 || 1;
  min -= padY;
  max += padY;
  const yPrice = (value) => priceTop + ((max - value) / (max - min)) * priceH;
  const xCenter = (index) => pad.l + slot * index + slot / 2;

  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
  ctx.fillStyle = "#93a197";
  for (let i = 0; i < 4; i += 1) {
    const value = max - ((max - min) * i) / 3;
    const y = yPrice(value);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(width - pad.r, y);
    ctx.stroke();
    ctx.fillText(fmt(value, value > 1000 ? 0 : 2), width - pad.r + 6, y + 4);
  }

  (view.events || []).forEach((event) => {
    if (event.impact !== "high") return;
    let x = null;
    if (event.t < candles[Math.max(0, candles.length - 45)].t) return;
    if (event.t > lastT) {
      const index = candles.length - 1 + (event.t - lastT) / interval;
      if (index > candles.length + extra) return;
      x = xCenter(index);
    } else {
      let nearest = 0;
      let best = Infinity;
      candles.forEach((bar, index) => {
        const dist = Math.abs(bar.t - event.t);
        if (dist < best) {
          best = dist;
          nearest = index;
        }
      });
      if (best > interval * 1.6 || event.t < candles[0].t - interval) return;
      x = xCenter(nearest);
    }
    ctx.strokeStyle = "rgba(215,181,109,0.55)";
    ctx.beginPath();
    ctx.moveTo(x, priceTop);
    ctx.lineTo(x, priceTop + priceH);
    ctx.stroke();
  });

  function stroke(key, color, widthPx) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = widthPx;
    let started = false;
    candles.forEach((bar, index) => {
      if (bar[key] === null || bar[key] === undefined) return;
      const x = xCenter(index);
      const y = yPrice(bar[key]);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  if (state.overlays.bb) {
    stroke("bb_up", "rgba(138,147,160,0.8)", 1);
    stroke("bb_low", "rgba(138,147,160,0.8)", 1);
  }
  if (state.overlays.vwap) stroke("vwap", "#c47c9b", 1.2);
  if (state.overlays.ema) {
    stroke("ema50", "#8eb4d4", 1.3);
    stroke("ema20", "#e0b15e", 1.5);
  }
  if (state.overlays.st) {
    ctx.beginPath();
    ctx.lineWidth = 1.4;
    let started = false;
    candles.forEach((bar, index) => {
      if (!bar.supertrend) return;
      ctx.strokeStyle = bar.st_dir === -1 ? "#d06565" : "#3c9d78";
      const x = xCenter(index);
      const y = yPrice(bar.supertrend);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y);
      }
    });
  }

  ctx.lineWidth = 1;
  candles.forEach((bar, index) => {
    const x = xCenter(index);
    const up = bar.c >= bar.o;
    ctx.strokeStyle = up ? "#1f8a62" : "#c45454";
    ctx.fillStyle = up ? "#1d6a46" : "#8d403c";
    ctx.beginPath();
    ctx.moveTo(x, yPrice(bar.h));
    ctx.lineTo(x, yPrice(bar.l));
    ctx.stroke();
    const top = yPrice(Math.max(bar.o, bar.c));
    const bottom = yPrice(Math.min(bar.o, bar.c));
    const body = Math.max(1, bottom - top);
    ctx.fillRect(x - Math.max(1.5, slot * 0.28), top, Math.max(3, slot * 0.56), body);
    if (bar.decision) {
      ctx.strokeStyle = "#d7b56d";
      ctx.strokeRect(x - Math.max(2, slot * 0.34), top - 2, Math.max(4, slot * 0.68), body + 4);
    }
  });

  const maxVol = Math.max(...candles.map((bar) => bar.v || 0), 1);
  candles.forEach((bar, index) => {
    const up = bar.c >= bar.o;
    ctx.fillStyle = up ? "rgba(31,138,98,0.75)" : "rgba(196,84,84,0.75)";
    const h = ((bar.v || 0) / maxVol) * volH;
    ctx.fillRect(xCenter(index) - Math.max(1.5, slot * 0.28), volTop + volH - h, Math.max(3, slot * 0.56), h);
  });

  drawOsc(ctx, candles, pad.l, oscTop, plotW, oscH, slot);
  ctx.fillStyle = "#93a197";
  ctx.fillText(dayKey(candles[0].t), pad.l, height - 6);
  ctx.fillText(dayKey(candles[candles.length - 1].t), width - pad.r - 70, height - 6);

  if (state.hover !== null) {
    const index = Math.min(candles.length - 1, Math.max(0, Math.floor((state.hover - pad.l) / slot)));
    const bar = candles[index];
    const x = xCenter(index);
    ctx.strokeStyle = "rgba(231,238,232,0.35)";
    ctx.beginPath();
    ctx.moveTo(x, priceTop);
    ctx.lineTo(x, oscTop + oscH);
    ctx.stroke();
    const text = `${dayKey(bar.t)}  开 ${fmt(bar.o, 2)}  高 ${fmt(bar.h, 2)}  低 ${fmt(bar.l, 2)}  收 ${fmt(bar.c, 2)}`;
    ctx.fillStyle = "#171c18";
    ctx.fillRect(pad.l, priceTop, ctx.measureText(text).width + 12, 18);
    ctx.fillStyle = "#e7eee8";
    ctx.fillText(text, pad.l + 6, priceTop + 13);
  }
}

function drawOsc(ctx, candles, left, top, plotW, oscH, slot) {
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left + plotW, top);
  ctx.stroke();
  const x = (index) => left + slot * index + slot / 2;
  if (state.osc === "rsi") {
    const y = (value) => top + ((100 - value) / 100) * oscH;
    [30, 50, 70].forEach((level) => {
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.moveTo(left, y(level));
      ctx.lineTo(left + plotW, y(level));
      ctx.stroke();
      ctx.fillStyle = "#93a197";
      ctx.fillText(String(level), left + plotW + 8, y(level) + 3);
    });
    ctx.beginPath();
    ctx.strokeStyle = "#d7b56d";
    ctx.lineWidth = 1.3;
    let started = false;
    candles.forEach((bar, index) => {
      if (bar.rsi === null || bar.rsi === undefined) return;
      if (!started) {
        ctx.moveTo(x(index), y(bar.rsi));
        started = true;
      } else ctx.lineTo(x(index), y(bar.rsi));
    });
    ctx.stroke();
    return;
  }
  let peak = 0;
  candles.forEach((bar) => {
    [bar.macd, bar.macd_signal, bar.macd_hist].forEach((value) => {
      if (value !== null && value !== undefined) peak = Math.max(peak, Math.abs(value));
    });
  });
  peak = peak || 1;
  const y = (value) => top + ((peak - value) / (2 * peak)) * oscH;
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.beginPath();
  ctx.moveTo(left, y(0));
  ctx.lineTo(left + plotW, y(0));
  ctx.stroke();
  candles.forEach((bar, index) => {
    if (bar.macd_hist === null || bar.macd_hist === undefined) return;
    ctx.fillStyle = bar.macd_hist >= 0 ? "rgba(31,138,98,0.8)" : "rgba(196,84,84,0.8)";
    const zero = y(0);
    const yy = y(bar.macd_hist);
    ctx.fillRect(x(index) - Math.max(1, slot * 0.22), Math.min(zero, yy), Math.max(2, slot * 0.44), Math.max(1, Math.abs(yy - zero)));
  });
  function line(key, color) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    let started = false;
    candles.forEach((bar, index) => {
      if (bar[key] === null || bar[key] === undefined) return;
      if (!started) {
        ctx.moveTo(x(index), y(bar[key]));
        started = true;
      } else ctx.lineTo(x(index), y(bar[key]));
    });
    ctx.stroke();
  }
  line("macd_signal", "#8eb4d4");
  line("macd", "#e0b15e");
}

function infoBlock(view) {
  const now = Date.now() / 1000;
  const events = (view.events || []).filter((event) => event.impact === "high");
  const future = events.filter((event) => event.t >= now - 6 * 3600).slice(0, 8);
  const past = events.filter((event) => event.t < now - 6 * 3600).slice(-6).reverse();
  const item = (event) =>
    el(
      "li",
      {},
      el("div", { class: "when" }, `${shanghai(event.t)} 上海 · ${event.source || ""}`),
      el("div", {}, event.title),
      event.estimate ? el("div", { class: "note" }, "这个日期被数据源标成估计。") : null
    );
  const news = (view.news || []).slice(0, 10).map((itemNews) =>
    el(
      "li",
      {},
      el("div", { class: "when" }, `${shanghai(itemNews.t)} · ${itemNews.source || "新闻"}`),
      el("a", { href: itemNews.url, target: "_blank", rel: "noreferrer" }, itemNews.title)
    )
  );
  return el(
    "div",
    { class: "split" },
    el(
      "section",
      { class: "panel" },
      el("h2", {}, "时间线"),
      el("p", { class: "note" }, "未来的竖线只来自已经排期的发布。新闻不会被写成还没发生的事。"),
      el("h2", {}, "接下来"),
      el("ul", { class: "timeline" }, ...(future.length ? future.map(item) : [el("li", {}, "这条时间线上暂时没有更晚的高影响日程。")])),
      el("h2", {}, "刚过去"),
      el("ul", { class: "timeline" }, ...past.map(item))
    ),
    el(
      "section",
      { class: "panel" },
      el("h2", {}, "相关新闻"),
      el("p", { class: "note" }, "标题不换算成多空分。密度变高时，先读完再决定技术读数还算不算数。"),
      el("ul", { class: "news" }, ...(news.length ? news : [el("li", {}, "这一轮没有取到新闻。")]))
    )
  );
}

function signalBlock(score) {
  const rows = [...(score.signals || [])].sort((a, b) => Math.abs(b.points || 0) - Math.abs(a.points || 0));
  return el(
    "section",
    { class: "panel" },
    el("h2", {}, "每一项怎么投票"),
    el(
      "table",
      {},
      el(
        "thead",
        {},
        el("tr", {}, el("th", {}, "指标"), el("th", {}, "组"), el("th", { class: "num" }, "对方向分的点数"), el("th", {}, "读数"))
      ),
      el(
        "tbody",
        {},
        ...rows.map((signal) =>
          el(
            "tr",
            {},
            el("td", {}, signal.name),
            el("td", {}, GROUPS[signal.group] || signal.group),
            el("td", { class: `num points ${tone(signal.points)}` }, signal.points === null || signal.points === undefined ? "不计" : signed(signal.points, 1)),
            el(
              "td",
              {},
              signal.reading,
              el("details", {}, el("summary", {}, "优点和缺点"), el("p", {}, signal.pros), el("p", {}, signal.cons))
            )
          )
        )
      )
    )
  );
}

function adjustmentBlock(score) {
  const items = score.adjustments || [];
  const risk = score.risk_parts || {};
  return el(
    "section",
    { class: "panel" },
    el("h2", {}, "交叉验证动过分数的地方"),
    items.length
      ? el(
          "ul",
          { class: "timeline" },
          ...items.map((item) => el("li", {}, el("b", {}, `${item.name} · ${item.effect}`), el("div", {}, item.text)))
        )
      : el("p", { class: "note" }, "这一轮没有额外折扣。各组投票已经体现在上面的点数里。"),
    el(
      "p",
      { class: "note" },
      `SCTI-RSK ${fmt(score.risk_score, 0)}。构成：${Object.entries(risk)
        .map(([key, value]) => `${key} ${fmt(value, 0)}`)
        .join("，") || "—"}。它只降低信心，不单独翻成反向单。`
    )
  );
}

function flowBlock(view) {
  const rows = view.flows || [];
  const rate = view.funding_rate;
  return el(
    "section",
    { class: "panel" },
    el("h2", {}, "比特币现货 ETF 净流"),
    el("p", { class: "note" }, "单位是百万美元，括号在源数据里表示流出。只覆盖美国现货 ETF。"),
    rate === null || rate === undefined
      ? null
      : el("p", {}, `OKX BTC 永续当前资金费率 ${fmt(rate * 100, 4)}% / 期。`),
    el(
      "table",
      {},
      el("thead", {}, el("tr", {}, el("th", {}, "日期（上海）"), el("th", { class: "num" }, "合计"))),
      el(
        "tbody",
        {},
        ...rows.slice().reverse().map((row) =>
          el(
            "tr",
            {},
            el("td", {}, dayKey(row.t)),
            el("td", { class: `num ${tone(row.total_musd)}` }, signed(row.total_musd, 1))
          )
        )
      )
    )
  );
}

function guideBlock(guide) {
  if (!guide) return el("section");
  return el(
    "section",
    { class: "panel" },
    el("h2", {}, guide.title),
    el(
      "div",
      { class: "guide" },
      ...guide.points.map((point) => el("article", {}, el("h3", {}, point.title), el("p", {}, point.body)))
    ),
    el("h2", { style: "margin-top:16px" }, "仍然没有覆盖的东西"),
    el("ul", { class: "timeline" }, ...guide.gaps.map((gap) => el("li", {}, gap))),
    el("p", { class: "summary" }, guide.use)
  );
}

window.addEventListener("resize", () => {
  if (state.view && state.view.candles) draw();
});

refresh();
setInterval(() => {
  if (document.visibilityState === "visible") refresh();
}, 60000);
