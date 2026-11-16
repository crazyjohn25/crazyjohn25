"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ColorType, CrosshairMode, LineStyle, createChart } from "lightweight-charts";

const SH_FULL = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const SH_DAY = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
});

const SH_HM = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function fmtNum(val, digits = 2) {
  if (val == null || Number.isNaN(Number(val))) return "—";
  return Number(val).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtVol(val) {
  if (val == null || Number.isNaN(Number(val))) return "—";
  const n = Number(val);
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(2)}万`;
  return n.toFixed(1);
}

function buildMarkers(candles, events, intervalSec) {
  if (!candles?.length || !events?.length) return [];
  const firstT = candles[0].t;
  const lastT = candles[candles.length - 1].t;
  const byBar = new Map();

  for (const ev of events) {
    if (ev.impact !== "high") continue;
    if (ev.t < firstT - intervalSec || ev.t > lastT + intervalSec * 1.5) continue;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < candles.length; i += 1) {
      const dist = Math.abs(candles[i].t - ev.t);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    if (bestDist > Math.max(intervalSec * 1.8, 86400)) continue;
    const barT = candles[bestIdx].t;
    const shortTag =
      ev.kind === "fomc"
        ? "FOMC决议"
        : ev.kind === "cpi"
          ? "CPI"
          : ev.kind === "nfp"
            ? "非农"
            : ev.kind === "ppi"
              ? "PPI"
              : ev.kind === "earnings"
                ? "财报"
                : "事件";
    const prev = byBar.get(barT);
    if (!prev || ev.kind === "earnings" || ev.kind === "fomc") {
      byBar.set(barT, {
        time: barT,
        position: "aboveBar",
        color: ev.kind === "earnings" ? "#f08c5b" : "#e3c06f",
        shape: "arrowDown",
        text: shortTag,
      });
    }
  }

  return [...byBar.values()].sort((a, b) => a.time - b.time);
}

function TradingViewNativeEmbed({ symbol, tvInterval }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    host.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "tradingview-widget-container";
    wrap.style.height = "100%";
    wrap.style.width = "100%";

    const inner = document.createElement("div");
    inner.className = "tradingview-widget-container__widget";
    inner.style.height = "100%";
    inner.style.width = "100%";
    wrap.appendChild(inner);

    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.text = JSON.stringify({
      autosize: true,
      symbol: symbol || "BINANCE:BTCUSDT",
      interval: tvInterval || "D",
      timezone: "Asia/Shanghai",
      theme: "dark",
      style: "1",
      locale: "zh_CN",
      backgroundColor: "rgba(18, 23, 20, 1)",
      gridColor: "rgba(44, 54, 49, 0.45)",
      withdateranges: true,
      hide_side_toolbar: false,
      allow_symbol_change: true,
      save_image: false,
      studies: ["STD;EMA", "STD;MACD", "STD;RSI"],
      support_host: "https://www.tradingview.com",
    });
    wrap.appendChild(script);
    host.appendChild(wrap);

    return () => {
      host.innerHTML = "";
    };
  }, [symbol, tvInterval]);

  return <div ref={containerRef} className="tv-embed-box" />;
}

export default function ProChart({
  view,
  horizon,
  horizons,
  onHorizonChange,
  onLiveTick,
  loadingHorizon,
}) {
  const [chartMode, setChartMode] = useState("pro");
  const [osc, setOsc] = useState("macd");
  const [logScale, setLogScale] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [wsState, setWsState] = useState("idle");
  const [hoverBar, setHoverBar] = useState(null);
  const [overlays, setOverlays] = useState({
    ema: true,
    boll: true,
    supertrend: true,
    bbi: false,
    vwap: false,
    levels: true,
    events: true,
  });

  const mainRef = useRef(null);
  const oscRef = useRef(null);
  const apiRef = useRef(null);
  const candlesMapRef = useRef(new Map());

  const candles = view?.candles || [];
  const digits = view?.digits ?? (view?.symbol === "^IXIC" || view?.symbol === "^SOX" ? 0 : 2);
  const intervalSec = view?.interval_sec || 86400;
  const playbook = view?.score?.ok ? view.score.playbook : null;

  const latestBar = useMemo(() => (candles.length ? candles[candles.length - 1] : null), [candles]);
  const activeBar = hoverBar || latestBar;

  const currentHorizonMeta = useMemo(
    () => (horizons || []).find((h) => h.key === horizon) || { tv_interval: "D" },
    [horizons, horizon],
  );

  // Build and update Lightweight Charts instance
  useEffect(() => {
    if (chartMode !== "pro") return undefined;
    const mainEl = mainRef.current;
    const oscEl = oscRef.current;
    if (!mainEl || !oscEl || !candles.length) return undefined;

    const map = new Map();
    for (const c of candles) map.set(c.t, c);
    candlesMapRef.current = map;
    setHoverBar(null);

    const tickFormatter = (time) => {
      const ts = typeof time === "number" ? time : 0;
      return intervalSec >= 86400 ? SH_DAY.format(new Date(ts * 1000)) : SH_HM.format(new Date(ts * 1000));
    };

    const commonOpts = {
      layout: {
        background: { type: ColorType.Solid, color: "#121714" },
        textColor: "#9aa89e",
        fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255, 255, 255, 0.04)" },
        horzLines: { color: "rgba(255, 255, 255, 0.04)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(215, 181, 109, 0.45)", labelBackgroundColor: "#26302a" },
        horzLine: { color: "rgba(215, 181, 109, 0.45)", labelBackgroundColor: "#26302a" },
      },
      localization: {
        locale: "zh-CN",
        timeFormatter: (time) => `${SH_FULL.format(new Date(Number(time) * 1000))} 上海`,
      },
      rightPriceScale: {
        borderColor: "#28322c",
        minimumWidth: 76,
      },
      timeScale: {
        borderColor: "#28322c",
        timeVisible: intervalSec < 86400,
        secondsVisible: false,
        rightOffset: 6,
        barSpacing: expanded ? 9 : 7.5,
        tickMarkFormatter: tickFormatter,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    };

    const mainHeight = expanded ? 520 : 390;
    const mainChart = createChart(mainEl, {
      ...commonOpts,
      width: mainEl.clientWidth,
      height: mainHeight,
      rightPriceScale: {
        ...commonOpts.rightPriceScale,
        mode: logScale ? 1 : 0,
        scaleMargins: { top: 0.07, bottom: 0.21 },
      },
    });

    const oscChart = createChart(oscEl, {
      ...commonOpts,
      width: oscEl.clientWidth,
      height: 148,
      rightPriceScale: {
        ...commonOpts.rightPriceScale,
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
    });

    const candleSeries = mainChart.addCandlestickSeries({
      upColor: "#22ab74",
      downColor: "#e05252",
      borderUpColor: "#22ab74",
      borderDownColor: "#e05252",
      wickUpColor: "#22ab74",
      wickDownColor: "#e05252",
      priceFormat: { type: "price", precision: digits, minMove: Number((10 ** -digits).toFixed(digits)) },
    });

    candleSeries.setData(
      candles.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c })),
    );

    const volSeries = mainChart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    mainChart.priceScale("vol").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });
    volSeries.setData(
      candles.map((c) => ({
        time: c.t,
        value: c.v || 0,
        color: c.c >= c.o ? "rgba(34, 171, 116, 0.38)" : "rgba(224, 82, 82, 0.38)",
      })),
    );

    const volMaSeries = mainChart.addLineSeries({
      color: "rgba(215, 181, 109, 0.65)",
      lineWidth: 1,
      priceScaleId: "vol",
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    });
    volMaSeries.setData(
      candles.filter((c) => c.vol_ma != null).map((c) => ({ time: c.t, value: c.vol_ma })),
    );

    const addOverlayLine = (key, color, width = 1, style = LineStyle.Solid) => {
      const s = mainChart.addLineSeries({
        color,
        lineWidth: width,
        lineStyle: style,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      });
      s.setData(candles.filter((c) => c[key] != null).map((c) => ({ time: c.t, value: c[key] })));
      return s;
    };

    if (overlays.ema) {
      addOverlayLine("ema20", "#f0b90b", 2);
      addOverlayLine("ema50", "#59a9ff", 1);
      addOverlayLine("ema200", "#b87aff", 2);
    }
    if (overlays.boll) {
      addOverlayLine("bb_up", "rgba(142, 180, 212, 0.68)", 1, LineStyle.Dashed);
      addOverlayLine("bb_mid", "rgba(142, 180, 212, 0.35)", 1, LineStyle.Dotted);
      addOverlayLine("bb_low", "rgba(142, 180, 212, 0.68)", 1, LineStyle.Dashed);
    }
    if (overlays.bbi) {
      addOverlayLine("bbi", "#ff944d", 1);
    }
    if (overlays.vwap) {
      addOverlayLine("vwap", "#e07ab8", 1);
    }
    if (overlays.supertrend) {
      const stSeries = mainChart.addLineSeries({
        lineWidth: 2,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      });
      stSeries.setData(
        candles
          .filter((c) => c.supertrend != null)
          .map((c) => ({
            time: c.t,
            value: c.supertrend,
            color: c.st_dir === -1 ? "#e05252" : "#22ab74",
          })),
      );
    }

    if (overlays.events) {
      candleSeries.setMarkers(buildMarkers(candles, view.events, intervalSec));
    }

    if (overlays.levels && playbook) {
      if (playbook.stop_level != null) {
        candleSeries.createPriceLine({
          price: playbook.stop_level,
          color: "#ef5350",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "止损/失效位",
        });
      }
      if (playbook.entry_low != null && playbook.entry_high != null) {
        const entryRef = playbook.bias === "short" ? playbook.entry_low : playbook.entry_high;
        candleSeries.createPriceLine({
          price: entryRef,
          color: "#e3c06f",
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: playbook.bias === "short" ? "反抽阻力沿" : "回踩关注沿",
        });
      }
      if (playbook.target_1 != null && playbook.bias !== "neutral") {
        candleSeries.createPriceLine({
          price: playbook.target_1,
          color: "#26a69a",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "目标参考 T1",
        });
      }
    }

    // Oscillator sub-pane
    if (osc === "macd") {
      const histS = oscChart.addHistogramSeries({
        priceLineVisible: false,
        lastValueVisible: false,
      });
      histS.setData(
        candles
          .filter((c) => c.macd_hist != null)
          .map((c) => ({
            time: c.t,
            value: c.macd_hist,
            color: c.macd_hist >= 0 ? "rgba(34, 171, 116, 0.78)" : "rgba(224, 82, 82, 0.78)",
          })),
      );
      const macdL = oscChart.addLineSeries({ color: "#f0b90b", lineWidth: 1, priceLineVisible: false });
      macdL.setData(candles.filter((c) => c.macd != null).map((c) => ({ time: c.t, value: c.macd })));
      const sigL = oscChart.addLineSeries({ color: "#59a9ff", lineWidth: 1, priceLineVisible: false });
      sigL.setData(candles.filter((c) => c.macd_signal != null).map((c) => ({ time: c.t, value: c.macd_signal })));
    } else if (osc === "rsi") {
      const rsiL = oscChart.addLineSeries({ color: "#e3c06f", lineWidth: 2, priceLineVisible: false });
      rsiL.setData(candles.filter((c) => c.rsi != null).map((c) => ({ time: c.t, value: c.rsi })));
      for (const [lv, col] of [[70, "rgba(224,82,82,0.45)"], [50, "rgba(255,255,255,0.18)"], [30, "rgba(34,171,116,0.45)"]]) {
        rsiL.createPriceLine({ price: lv, color: col, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "" });
      }
    } else if (osc === "kdj") {
      const kL = oscChart.addLineSeries({ color: "#f0b90b", lineWidth: 1, priceLineVisible: false, title: "K" });
      const dL = oscChart.addLineSeries({ color: "#59a9ff", lineWidth: 1, priceLineVisible: false, title: "D" });
      const jL = oscChart.addLineSeries({ color: "#d97aff", lineWidth: 1, priceLineVisible: false, title: "J" });
      kL.setData(candles.filter((c) => c.k != null).map((c) => ({ time: c.t, value: c.k })));
      dL.setData(candles.filter((c) => c.d != null).map((c) => ({ time: c.t, value: c.d })));
      jL.setData(candles.filter((c) => c.j != null).map((c) => ({ time: c.t, value: c.j })));
    } else if (osc === "adx") {
      const adxL = oscChart.addLineSeries({ color: "#e3c06f", lineWidth: 2, priceLineVisible: false, title: "ADX" });
      const pdiL = oscChart.addLineSeries({ color: "#22ab74", lineWidth: 1, priceLineVisible: false, title: "+DI" });
      const mdiL = oscChart.addLineSeries({ color: "#e05252", lineWidth: 1, priceLineVisible: false, title: "-DI" });
      adxL.setData(candles.filter((c) => c.adx != null).map((c) => ({ time: c.t, value: c.adx })));
      pdiL.setData(candles.filter((c) => c.plus_di != null).map((c) => ({ time: c.t, value: c.plus_di })));
      mdiL.setData(candles.filter((c) => c.minus_di != null).map((c) => ({ time: c.t, value: c.minus_di })));
      adxL.createPriceLine({ price: 25, color: "rgba(227,192,111,0.4)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "趋势25" });
    } else if (osc === "obv") {
      const obvL = oscChart.addLineSeries({ color: "#59c4b0", lineWidth: 2, priceLineVisible: false, title: "OBV" });
      obvL.setData(candles.filter((c) => c.obv != null).map((c) => ({ time: c.t, value: c.obv })));
    }

    // Show recent ~110 candles initially while keeping all 320 scrollable
    const total = candles.length;
    if (total > 120) {
      const range = { from: total - 115, to: total + 6 };
      mainChart.timeScale().setVisibleLogicalRange(range);
      oscChart.timeScale().setVisibleLogicalRange(range);
    } else {
      mainChart.timeScale().fitContent();
      oscChart.timeScale().fitContent();
    }

    // Two-way logical range sync
    let syncing = false;
    mainChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (syncing || !range) return;
      syncing = true;
      oscChart.timeScale().setVisibleLogicalRange(range);
      syncing = false;
    });
    oscChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (syncing || !range) return;
      syncing = true;
      mainChart.timeScale().setVisibleLogicalRange(range);
      syncing = false;
    });

    mainChart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setHoverBar(null);
        return;
      }
      const hit = candlesMapRef.current.get(Number(param.time));
      if (hit) setHoverBar(hit);
    });

    const onResize = () => {
      if (!mainEl || !oscEl) return;
      mainChart.applyOptions({ width: mainEl.clientWidth });
      oscChart.applyOptions({ width: oscEl.clientWidth });
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mainEl);

    apiRef.current = { mainChart, oscChart, candleSeries, volSeries };

    return () => {
      ro.disconnect();
      apiRef.current = null;
      mainChart.remove();
      oscChart.remove();
    };
  }, [chartMode, candles, digits, intervalSec, logScale, expanded, osc, overlays, playbook, view?.events]);

  // Direct Binance Live WebSocket stream for real-time ticks on BTC & HYPE
  useEffect(() => {
    const wsSymbol = view?.ws_symbol;
    if (!wsSymbol || chartMode !== "pro") {
      setWsState("idle");
      return undefined;
    }
    let closed = false;
    let socket = null;
    setWsState("connecting");
    try {
      socket = new WebSocket(`wss://data-stream.binance.vision:9443/ws/${wsSymbol}@kline_${horizon}`);
      socket.onopen = () => {
        if (!closed) setWsState("live");
      };
      socket.onmessage = (event) => {
        if (closed || !apiRef.current) return;
        try {
          const msg = JSON.parse(event.data);
          const k = msg.k;
          if (!k) return;
          const bar = {
            t: Math.floor(Number(k.t) / 1000),
            o: Number(k.o),
            h: Number(k.h),
            l: Number(k.l),
            c: Number(k.c),
            v: Number(k.v),
          };
          apiRef.current.candleSeries.update({
            time: bar.t,
            open: bar.o,
            high: bar.h,
            low: bar.l,
            close: bar.c,
          });
          apiRef.current.volSeries.update({
            time: bar.t,
            value: bar.v,
            color: bar.c >= bar.o ? "rgba(34, 171, 116, 0.38)" : "rgba(224, 82, 82, 0.38)",
          });
          const prev = candlesMapRef.current.get(bar.t) || {};
          candlesMapRef.current.set(bar.t, { ...prev, ...bar });
          onLiveTick?.(bar.c);
        } catch {
          // ignore malformed tick
        }
      };
      socket.onerror = () => {
        if (!closed) setWsState("rest");
      };
      socket.onclose = () => {
        if (!closed) setWsState("rest");
      };
    } catch {
      setWsState("rest");
    }
    return () => {
      closed = true;
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        socket.close();
      }
    };
  }, [view?.ws_symbol, horizon, chartMode, onLiveTick]);

  const toggleOverlay = (key) => setOverlays((prev) => ({ ...prev, [key]: !prev[key] }));

  const resetView = () => {
    if (!apiRef.current || !candles.length) return;
    const total = candles.length;
    const range = total > 120 ? { from: total - 115, to: total + 6 } : null;
    if (range) {
      apiRef.current.mainChart.timeScale().setVisibleLogicalRange(range);
      apiRef.current.oscChart.timeScale().setVisibleLogicalRange(range);
    } else {
      apiRef.current.mainChart.timeScale().fitContent();
      apiRef.current.oscChart.timeScale().fitContent();
    }
  };

  const barChange =
    activeBar && activeBar.o
      ? (((activeBar.c - activeBar.o) / activeBar.o) * 100).toFixed(2)
      : null;

  return (
    <section className={`panel chart-panel${expanded ? " chart-expanded" : ""}`}>
      <div className="chart-header-bar">
        <div className="mode-tabs" role="tablist" aria-label="图表引擎">
          <button
            type="button"
            className={`mode-tab${chartMode === "pro" ? " active" : ""}`}
            onClick={() => setChartMode("pro")}
          >
            量化核对专业 K 线（含作战价位线）
          </button>
          <button
            type="button"
            className={`mode-tab${chartMode === "tv" ? " active" : ""}`}
            onClick={() => setChartMode("tv")}
          >
            TradingView 官方原生终端
          </button>
        </div>

        <div className="feed-badges">
          {view?.ws_symbol && chartMode === "pro" ? (
            <span className={`feed-pill ${wsState === "live" ? "live" : ""}`}>
              <i className="dot" />
              {wsState === "live" ? "Binance WebSocket 实时秒级推送" : "Binance 现货行情"}
            </span>
          ) : (
            <span className="feed-pill">{view?.source_name || "交易所公开行情"}</span>
          )}
          {loadingHorizon ? <span className="feed-pill syncing">正在同步 {loadingHorizon}…</span> : null}
        </div>
      </div>

      <div className="chart-toolbar">
        <div className="tf-group" role="group" aria-label="K线周期">
          {(horizons || []).map((item) => (
            <button
              key={item.key}
              type="button"
              className={`tf-btn${horizon === item.key ? " active" : ""}`}
              onClick={() => onHorizonChange(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {chartMode === "pro" ? (
          <>
            <div className="tf-group" role="group" aria-label="主图指标">
              {[
                ["ema", "EMA 20/50/200"],
                ["boll", "BOLL"],
                ["supertrend", "Supertrend"],
                ["bbi", "BBI"],
                ["vwap", "VWAP"],
                ["levels", "买卖/止损线"],
                ["events", "事件标记"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`chip-btn${overlays[key] ? " on" : ""}`}
                  onClick={() => toggleOverlay(key)}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="tf-group" role="group" aria-label="视图控制">
              <button
                type="button"
                className={`chip-btn${logScale ? " on" : ""}`}
                onClick={() => setLogScale((v) => !v)}
              >
                对数坐标
              </button>
              <button type="button" className="chip-btn" onClick={resetView}>
                复位缩放
              </button>
              <button
                type="button"
                className={`chip-btn${expanded ? " on" : ""}`}
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? "收起高度" : "加高看盘"}
              </button>
            </div>
          </>
        ) : null}
      </div>

      {chartMode === "pro" ? (
        <>
          {activeBar ? (
            <div className="ohlc-strip">
              <span className="ohlc-time">{SH_FULL.format(new Date(activeBar.t * 1000))} 上海</span>
              <span>开 <b>{fmtNum(activeBar.o, digits)}</b></span>
              <span>高 <b className="up">{fmtNum(activeBar.h, digits)}</b></span>
              <span>低 <b className="down">{fmtNum(activeBar.l, digits)}</b></span>
              <span>收 <b>{fmtNum(activeBar.c, digits)}</b></span>
              {barChange != null ? (
                <span className={Number(barChange) >= 0 ? "up" : "down"}>
                  {Number(barChange) >= 0 ? `+${barChange}%` : `${barChange}%`}
                </span>
              ) : null}
              <span>量 <b>{fmtVol(activeBar.v)}</b></span>
              {overlays.ema ? (
                <>
                  <span style={{ color: "#f0b90b" }}>EMA20 {fmtNum(activeBar.ema20, digits)}</span>
                  <span style={{ color: "#59a9ff" }}>EMA50 {fmtNum(activeBar.ema50, digits)}</span>
                  <span style={{ color: "#b87aff" }}>EMA200 {fmtNum(activeBar.ema200, digits)}</span>
                </>
              ) : null}
              {overlays.supertrend && activeBar.supertrend != null ? (
                <span style={{ color: activeBar.st_dir === -1 ? "#e05252" : "#22ab74" }}>
                  ST {fmtNum(activeBar.supertrend, digits)}
                </span>
              ) : null}
            </div>
          ) : null}

          <div ref={mainRef} className="lw-main-canvas" />

          <div className="osc-bar">
            <span className="muted">联动副图指标：</span>
            {[
              ["macd", "MACD (12,26,9)"],
              ["rsi", "RSI (14)"],
              ["kdj", "KDJ (9,3,3)"],
              ["adx", "DMI / ADX"],
              ["obv", "OBV 能量潮"],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`chip-btn${osc === key ? " on" : ""}`}
                onClick={() => setOsc(key)}
              >
                {label}
              </button>
            ))}
            <span className="osc-hint muted">支持滚轮缩放 K 线 · 按住拖拽历史 · 拖拽右侧价格轴调节纵比</span>
          </div>

          <div ref={oscRef} className="lw-osc-canvas" />
        </>
      ) : (
        <TradingViewNativeEmbed
          symbol={view?.tv_symbol || "BINANCE:BTCUSDT"}
          tvInterval={currentHorizonMeta.tv_interval}
        />
      )}
    </section>
  );
}
