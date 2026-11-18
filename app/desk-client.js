"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ProChart from "./pro-chart";
import SimWallet from "./sim-wallet";

const GROUPS = {
  trend: "趋势方向组",
  momentum: "动量摆动组",
  volume: "量价资金组",
  location: "通道位置组",
  relative: "跨市场强弱",
  summary: "三组共振",
  flow: "机构/衍生品流",
};

const SH_FMT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const SH_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function fmt(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function signed(value, digits = 0) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const num = Number(value);
  const text = fmt(Math.abs(num), digits);
  if (num > 0) return `+${text}`;
  if (num < 0) return `-${text}`;
  return text;
}

function tone(value, threshold = 8) {
  if (value == null || Number.isNaN(Number(value)) || Math.abs(Number(value)) < threshold) return "flat";
  return Number(value) > 0 ? "up" : "down";
}

const SIZE_LABEL = {
  full: "新仓可按执行档仓位上限分批",
  half: "同向周期不全，新仓按执行档上限减半",
  none: "不新开仓",
};

function AdviceBoard({ plans, synthesis, digits, activeHorizon, onFocusHorizon }) {
  if (!synthesis) return null;
  const rows = plans || [];
  const operate = rows.find((plan) => plan.id === synthesis.operate_id);
  return (
    <section className="synthesis-card panel">
      <div className="playbook-header">
        <h2>综合结论</h2>
        <span className="muted">短线 20% · 中线 35% · 长线 45%</span>
      </div>
      <div className="synthesis-headline-row">
        <strong className={tone(synthesis.composite_score, 18)}>{synthesis.headline}</strong>
        {synthesis.composite_score != null ? (
          <span className={`score-pill ${tone(synthesis.composite_score, 18)}`}>
            加权 {signed(synthesis.composite_score, 0)}
          </span>
        ) : null}
      </div>
      <p className="synthesis-thesis">{synthesis.thesis}</p>
      <div className="synthesis-meta">
        <span>共振：{synthesis.alignment}</span>
        <span>信心：{synthesis.confidence}</span>
        <span>仓位：{SIZE_LABEL[synthesis.size] || SIZE_LABEL.none}</span>
        <span>
          执行档：{synthesis.actionable && operate ? operate.label : "暂不指定"}
        </span>
      </div>
      {operate?.ok && synthesis.actionable && operate.bias !== "neutral" ? (
        <div className="levels-grid synthesis-levels">
          <div className="level-item">
            <span>{operate.label}开仓区 · {operate.zone_title}</span>
            <b className="num flat">{fmt(operate.entry_low, digits)} – {fmt(operate.entry_high, digits)}</b>
            <small className="muted">{synthesis.actionable ? "只在这个区间分批，不追当前价" : "当前不新开仓，这个区间只供核对"}</small>
          </div>
          <div className="level-item">
            <span>SL 止损 / 结构失效</span>
            <b className="num down">
              {fmt(operate.stop, digits)}
              {operate.stop_pct != null ? ` (${signed(operate.stop_pct, 2)}%)` : ""}
            </b>
            <small className="muted">收盘越过该价，这笔执行档逻辑作废</small>
          </div>
          <div className="level-item">
            <span>TP1 / TP2 止盈</span>
            <b className="num up">{fmt(operate.tp1, digits)} / {fmt(operate.tp2, digits)}</b>
            <small className="muted">TP1 先减仓，TP2 是结构延伸目标</small>
          </div>
          <div className="level-item">
            <span>回踩盈亏比 · 仓位上限</span>
            <b className="num">{operate.rr_pullback ?? "—"} : 1</b>
            <small className="muted">{operate.position_cap}</small>
          </div>
        </div>
      ) : null}
      <div className="horizon-plan-grid">
        {rows.map((plan) => (
          <article
            key={plan.id}
            className={`horizon-plan${activeHorizon === plan.horizon ? " viewing" : ""}${synthesis.actionable && synthesis.operate_id === plan.id ? " execute" : ""}`}
          >
            <header>
              <div>
                <b>{plan.label}</b>
                <span className="muted">{plan.hold}</span>
              </div>
              {plan.ok ? (
                <span className={`score-pill ${tone(plan.action_score, 18)}`}>{signed(plan.action_score, 0)}</span>
              ) : (
                <span className="score-pill flat">样本不足</span>
              )}
            </header>
            <p className="horizon-role">{plan.role}</p>
            {plan.ok ? (
              <>
                <p className={`horizon-verdict ${plan.verdict_tone || "flat"}`}>{plan.verdict_title}</p>
                {plan.bias === "neutral" ? (
                  <dl>
                    <div>
                      <dt>区间下沿</dt>
                      <dd>{fmt(plan.entry_low, digits)}</dd>
                    </div>
                    <div>
                      <dt>区间上沿</dt>
                      <dd>{fmt(plan.entry_high, digits)}</dd>
                    </div>
                    <div>
                      <dt>失效参考</dt>
                      <dd className="down">{fmt(plan.stop, digits)}</dd>
                    </div>
                    <div>
                      <dt>止盈</dt>
                      <dd>无单边目标</dd>
                    </div>
                  </dl>
                ) : (
                  <dl>
                    <div>
                      <dt>开仓</dt>
                      <dd>{fmt(plan.entry_low, digits)} – {fmt(plan.entry_high, digits)}</dd>
                    </div>
                    <div>
                      <dt>SL</dt>
                      <dd className="down">{fmt(plan.stop, digits)}</dd>
                    </div>
                    <div>
                      <dt>TP1</dt>
                      <dd className="up">{fmt(plan.tp1, digits)}</dd>
                    </div>
                    <div>
                      <dt>TP2</dt>
                      <dd className="up">{fmt(plan.tp2, digits)}</dd>
                    </div>
                  </dl>
                )}
                <p className="horizon-action">{plan.bias === "short" ? plan.swing_action : plan.spot_action}</p>
                <button type="button" className="chip-btn" onClick={() => onFocusHorizon(plan.horizon)}>
                  {activeHorizon === plan.horizon ? "当前正在看这张图" : "在 K 线上查看这一档"}
                </button>
              </>
            ) : (
              <p className="muted">{plan.reason}</p>
            )}
          </article>
        ))}
      </div>
      <p className="note">{synthesis.method}</p>
    </section>
  );
}

function shortActionTag(score) {
  if (score == null || Number.isNaN(Number(score))) return "待核对";
  const v = Number(score);
  if (v >= 55) return "强看多";
  if (v >= 25) return "偏多";
  if (v <= -55) return "强看空";
  if (v <= -25) return "偏空";
  return "观望";
}

function shanghaiTime(ts) {
  if (!ts) return "—";
  return SH_FMT.format(new Date(ts * 1000));
}

function shanghaiDay(ts) {
  if (!ts) return "—";
  return SH_DATE.format(new Date(ts * 1000));
}

export default function DeskClient({ initialBoard = null, initialView = null }) {
  const [assetId, setAssetId] = useState(initialView?.id || "btc");
  const [horizon, setHorizon] = useState(initialView?.horizon || "1d");
  const [boardData, setBoardData] = useState(initialBoard);
  const [view, setView] = useState(initialView);
  const [livePrice, setLivePrice] = useState(null);
  const [loadingAsset, setLoadingAsset] = useState(!initialView);
  const [loadingHorizon, setLoadingHorizon] = useState(null);
  const [showScoreHelp, setShowScoreHelp] = useState(false);
  const [showAllSignals, setShowAllSignals] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  const cacheRef = useRef(new Map());
  const reqSeqRef = useRef(0);

  // Seed initial view into client cache
  useEffect(() => {
    if (initialView?.id && initialView?.horizon) {
      cacheRef.current.set(`${initialView.id}:${initialView.horizon}`, {
        at: Date.now(),
        data: initialView,
      });
    }
  }, [initialView]);

  const fetchBoardSilent = useCallback(async () => {
    try {
      const res = await fetch("/api/board", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setBoardData(data);
    } catch {
      // keep existing board
    }
  }, []);

  const loadAsset = useCallback(async (targetId, targetHorizon, { force = false } = {}) => {
    const key = `${targetId}:${targetHorizon}`;
    const cachedHit = cacheRef.current.get(key);
    const seq = ++reqSeqRef.current;

    if (!force && cachedHit) {
      setView(cachedHit.data);
      setLivePrice(null);
      setLoadingAsset(false);
      setLoadingHorizon(null);
      setErrorMsg(null);
      if (Date.now() - cachedHit.at < 20_000) return;
    } else {
      if (!cachedHit) setLoadingHorizon(targetHorizon);
    }

    try {
      const res = await fetch(
        `/api/asset?id=${encodeURIComponent(targetId)}&horizon=${encodeURIComponent(targetHorizon)}`,
        { cache: "no-store" },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "读取标的数据失败");
      cacheRef.current.set(key, { at: Date.now(), data });
      if (seq === reqSeqRef.current) {
        setView(data);
        setLivePrice(null);
        setErrorMsg(null);
      }
    } catch (err) {
      if (seq === reqSeqRef.current && !cachedHit) {
        setErrorMsg(err instanceof Error ? err.message : "网络读取异常");
      }
    } finally {
      if (seq === reqSeqRef.current) {
        setLoadingAsset(false);
        setLoadingHorizon(null);
      }
    }
  }, []);

  const prefetchAsset = useCallback((targetId, targetHorizon) => {
    const key = `${targetId}:${targetHorizon}`;
    const hit = cacheRef.current.get(key);
    if (hit && Date.now() - hit.at < 30_000) return;
    fetch(`/api/asset?id=${encodeURIComponent(targetId)}&horizon=${encodeURIComponent(targetHorizon)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) cacheRef.current.set(key, { at: Date.now(), data });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!initialBoard) fetchBoardSilent();
    if (!initialView) loadAsset("btc", "1d");
  }, [initialBoard, initialView, fetchBoardSilent, loadAsset]);

  // Background refresh every 45s
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      fetchBoardSilent();
      loadAsset(assetId, horizon, { force: true });
    }, 45_000);
    return () => clearInterval(timer);
  }, [assetId, horizon, fetchBoardSilent, loadAsset]);

  const handleSelectAsset = (nextId) => {
    if (nextId === assetId) return;
    setAssetId(nextId);
    setLivePrice(null);
    loadAsset(nextId, horizon);
  };

  const handleSelectHorizon = (nextHorizon) => {
    if (nextHorizon === horizon) return;
    setHorizon(nextHorizon);
    setLivePrice(null);
    loadAsset(assetId, nextHorizon);
  };

  const handleManualRefresh = () => {
    setLoadingHorizon(horizon);
    fetchBoardSilent();
    loadAsset(assetId, horizon, { force: true });
  };

  const handleLiveTick = useCallback((price) => {
    setLivePrice(price);
  }, []);

  const horizons = view?.horizons || boardData?.horizons || [
    { key: "5m", label: "5分", tv_interval: "5" },
    { key: "15m", label: "15分", tv_interval: "15" },
    { key: "1h", label: "1小时", tv_interval: "60" },
    { key: "4h", label: "4小时", tv_interval: "240" },
    { key: "1d", label: "日线", tv_interval: "D" },
    { key: "1w", label: "周线", tv_interval: "W" },
  ];

  const digits = view?.digits ?? (view?.symbol === "^IXIC" || view?.symbol === "^SOX" ? 0 : 2);
  const shownPrice = livePrice ?? view?.price;
  const score = view?.score || { ok: false };
  const playbook = score.ok ? score.playbook : null;

  const markerLeftPct = useMemo(() => {
    if (!score.ok || score.action_score == null) return 50;
    const clamped = Math.max(-100, Math.min(100, Number(score.action_score)));
    return ((clamped + 100) / 200) * 100;
  }, [score.ok, score.action_score]);

  const sortedSignals = useMemo(() => {
    const list = [...(score.signals || [])];
    list.sort((a, b) => Math.abs(b.points || 0) - Math.abs(a.points || 0));
    return showAllSignals ? list : list.slice(0, 10);
  }, [score.signals, showAllSignals]);

  const nowSec = Date.now() / 1000;
  const highEvents = useMemo(
    () => (view?.events || []).filter((ev) => ev.impact === "high"),
    [view?.events],
  );
  const futureEvents = useMemo(
    () => highEvents.filter((ev) => ev.t >= nowSec - 6 * 3600).slice(0, 7),
    [highEvents, nowSec],
  );
  const pastEvents = useMemo(
    () => highEvents.filter((ev) => ev.t < nowSec - 6 * 3600).slice(-5).reverse(),
    [highEvents, nowSec],
  );

  return (
    <div className="desk-shell">
      <header className="top">
        <div>
          <div className="brand-row">
            <p className="brand">核对台 Pro</p>
            <span className="pro-badge">Binance 实时流 · TradingView 双引擎 · 多周期决策</span>
          </div>
          <p className="tag">
            将 19 项多周期指标、美联储/CPI/财报时间窗与机构资金流交叉核对，给出客观、不迎合、讲清赔率与止损位的投资建议。
          </p>
        </div>

        <div className="top-actions">
          <div className="clock">
            {boardData?.as_of
              ? `上海时间 ${boardData.as_of.replace("T", " ").slice(0, 16)} (UTC+8)`
              : "正在同步交易所公开数据…"}
          </div>
          <div className="top-btns">
            <button
              type="button"
              className={`chip-btn${showScoreHelp ? " on" : ""}`}
              onClick={() => setShowScoreHelp((v) => !v)}
            >
              {showScoreHelp ? "收起正负分说明" : "正分 / 负分怎么看？"}
            </button>
            <button type="button" className="chip-btn" onClick={handleManualRefresh}>
              立即刷新
            </button>
          </div>
        </div>
      </header>

      {showScoreHelp ? (
        <section className="score-explainer-banner">
          <div className="explainer-grid">
            <div className="exp-card">
              <b className="up">+ 正分是什么意思？（+1 ~ +100）</b>
              <p>
                代表<strong>多头（看涨）力量占上风</strong>。<b>+25 ~ +54</b> 表示温和偏多，适合等回调分批低吸；
                <b>+55 ~ +100</b> 表示均线、动量、成交量与大周期强力看涨共振，且入场位置合理。
              </p>
            </div>
            <div className="exp-card">
              <b className="down">- 负分是什么意思？（-1 ~ -100）</b>
              <p>
                代表<strong>空头（下跌）压力占上风</strong>。<b>-25 ~ -54</b> 表示偏空承压，现货持有者应逢反弹减仓防守、切忌盲目抄底；
                <b>-55 ~ -100</b> 表示明确空头下跌趋势，严禁左侧“接飞刀”。
              </p>
            </div>
            <div className="exp-card">
              <b className="flat">-24 ~ +24 观望区 & 核心公式</b>
              <p>
                <code>综合总分 = 趋势方向分 × (入场时机分 ÷ 100)</code>。哪怕大方向看涨（如 +50），如果刚暴涨远离均线或明晚发财报（时机分仅 35），综合分也会压回 +18 提醒你<strong>别在山顶追高</strong>。
              </p>
            </div>
          </div>
        </section>
      ) : null}

      <div className="sim-wrap">
        <SimWallet board={boardData} liveAssetId={assetId} livePrice={shownPrice} />
      </div>

      <div className="layout">
        <aside id="rail" aria-label="监控标的">
          <div className="rail-title-row">
            <span className="muted">监控标的（日线基准分）</span>
            <span className="muted">点击秒切</span>
          </div>

          {(boardData?.cards || []).map((card) => {
            const cardDigits = card.digits ?? (card.symbol === "^IXIC" || card.symbol === "^SOX" ? 0 : 2);
            const active = card.id === assetId;
            const chg = card.change_pct != null ? card.change_pct * 100 : null;
            return (
              <button
                key={card.id}
                type="button"
                className={`card${active ? " active" : ""}`}
                onMouseEnter={() => prefetchAsset(card.id, horizon)}
                onClick={() => handleSelectAsset(card.id)}
              >
                <div className="card-top">
                  <div>
                    <b>{card.name}</b>
                    <span className="card-sym">{card.symbol}</span>
                  </div>
                  <span className={`score-pill ${tone(card.action_score, 25)}`}>
                    {card.action_score != null
                      ? `${signed(card.action_score, 0)} · ${shortActionTag(card.action_score)}`
                      : "—"}
                  </span>
                </div>

                <div className="card-price-row">
                  <span className="num card-px">
                    {card.price != null ? fmt(card.price, cardDigits) : "—"}
                  </span>
                  {chg != null ? (
                    <span className={`num card-chg ${tone(chg, 0.01)}`}>{signed(chg, 2)}%</span>
                  ) : null}
                </div>

                <div className="card-verdict muted">
                  {card.verdict_title || card.stance_label || card.error || ""}
                </div>
              </button>
            );
          })}

          {boardData?.cluster?.text ? <p className="note rail-cluster">{boardData.cluster.text}</p> : null}
        </aside>

        <main id="main">
          {errorMsg && !view ? (
            <div className="panel">
              <p className="error">{errorMsg}</p>
              <button type="button" className="chip-btn on" onClick={handleManualRefresh}>
                重新加载
              </button>
            </div>
          ) : loadingAsset && !view ? (
            <div className="panel">
              <p className="loading">正在同步交易所多周期 K 线与量化评分…</p>
            </div>
          ) : view ? (
            <>
              {/* Asset Header */}
              <div className="head">
                <div>
                  <div className="symbol-row">
                    <span className="symbol">{view.symbol} · {view.pair}</span>
                    {view.ipo_date ? (
                      <span className="ipo-tag">已上市 · {view.ipo_date} IPO (${view.ipo_price})</span>
                    ) : null}
                    <span className="horizon-tag">当前评估周期：{view.horizon_full_label || view.horizon_label}</span>
                  </div>
                  <h1>{view.name}</h1>
                  <p className="note">{view.note}</p>
                </div>

                <div className="price-box">
                  <p className="price">{shownPrice != null ? fmt(shownPrice, digits) : "—"}</p>
                  <p className={tone(view.change_pct != null ? view.change_pct * 100 : null, 0.01)}>
                    {view.change_pct != null ? `${signed(view.change_pct * 100, 2)}% · ` : ""}
                    {view.session || ""}
                  </p>
                  <p className="note">
                    {view.live_bar
                      ? "现价实时跳动；为防盘中假信号，打分锚定最近一根已收盘 K 线。"
                      : "当前周期最新 K 线已收盘确认。"}
                  </p>
                </div>
              </div>

              {/* Warnings */}
              {(view.warnings || []).map((w) => (
                <p key={w} className="warn">{w}</p>
              ))}

              <AdviceBoard
                plans={view.horizon_plans}
                synthesis={view.synthesis}
                digits={digits}
                activeHorizon={horizon}
                onFocusHorizon={handleSelectHorizon}
              />

              {/* Score Thermometer + Faithful Investment Playbook */}
              {score.ok && playbook ? (
                <section className="decision-board">
                  <div className="score-spectrum-card panel">
                    <div className="spectrum-top">
                      <div>
                        <span className="muted">{score.regime_label} · {view.horizon_label}级别综合多空总分</span>
                        <div className="big-score-line">
                          <strong className={`big-score ${tone(score.action_score, 25)}`}>
                            {signed(score.action_score, 0)}
                          </strong>
                          <span className={`verdict-chip ${playbook.verdict_tone}`}>
                            {playbook.verdict_title}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="link-hint"
                        onClick={() => setShowScoreHelp((v) => !v)}
                      >
                        {showScoreHelp ? "隐藏打分规则" : "看不懂正负分？点此展开白话说明"}
                      </button>
                    </div>

                    {/* Visual -100 to +100 Spectrum Bar */}
                    <div className="spectrum-wrap" aria-label="多空评分光谱 -100 到 +100">
                      <div className="spectrum-track">
                        <span className="seg seg-s2">强空头 (-100~-55)</span>
                        <span className="seg seg-s1">偏空防守 (-54~-25)</span>
                        <span className="seg seg-0">观望区 (-24~+24)</span>
                        <span className="seg seg-l1">温和偏多 (+25~+54)</span>
                        <span className="seg seg-l2">强多头 (+55~+100)</span>
                        <div className="spectrum-needle" style={{ left: `${markerLeftPct}%` }}>
                          <span>{signed(score.action_score, 0)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="sub-scores-grid">
                      <div className="metric">
                        <span>① 趋势方向分（-100 看空 ~ +100 看多）</span>
                        <b className={tone(score.direction_score, 15)}>{signed(score.direction_score, 0)}</b>
                        <small className="muted">
                          {score.direction_score >= 25
                            ? "多头指标占优，大方向向上"
                            : score.direction_score <= -25
                              ? "空头指标占优，大方向承压"
                              : "多空力量接近，无明显单边"}
                        </small>
                      </div>
                      <div className="metric">
                        <span>② 入场时机性价比（0 ~ 100 分）</span>
                        <b>{fmt(score.execution_score, 0)} / 100</b>
                        <small className="muted">
                          {score.execution_score >= 65
                            ? "靠近关键均线/支撑，位置较好"
                            : score.execution_score <= 42
                              ? "短线偏离过大或临近重大事件，忌追单"
                              : "位置中性，宜分批勿重仓"}
                        </small>
                      </div>
                      <div className="metric">
                        <span>③ 盘面颠簸与事件风险（0 ~ 100）</span>
                        <b className={score.risk_score >= 70 ? "down" : ""}>{fmt(score.risk_score, 0)} / 100</b>
                        <small className="muted">
                          {score.risk_score >= 70
                            ? "高波动或财报/宏观窗口，需缩减仓位"
                            : "波动处于常态可控范围"}
                        </small>
                      </div>
                    </div>
                  </div>

                  {/* Actionable Playbook */}
                  <div className="playbook-card panel">
                    <div className="playbook-header">
                      <h2>当前图周期的证据（{view.horizon_label} · 对照{view.higher_label}）</h2>
                      <span className="muted">开仓、止盈、止损以短线 / 中线 / 长线三档为准</span>
                    </div>

                    {view.synthesis ? null : (
                      <>
                        <div className="advice-columns">
                          <div className="advice-box">
                            <span className="advice-role">现货 / 美股长波段建议</span>
                            <p>{playbook.spot_action}</p>
                          </div>
                          <div className="advice-box">
                            <span className="advice-role">短波段 / 双向交易执行纪律</span>
                            <p>{playbook.swing_action}</p>
                          </div>
                        </div>

                        <div className="levels-grid">
                          <div className="level-item">
                            <span>{playbook.zone_title}</span>
                            <b className="num flat">
                              {fmt(playbook.entry_low, digits)} – {fmt(playbook.entry_high, digits)}
                            </b>
                            <small className="muted">避免现价情绪化追单的参考带</small>
                          </div>
                          <div className="level-item">
                            <span>结构止损 / 逻辑失效位</span>
                            <b className="num down">
                              {fmt(playbook.stop_level, digits)}
                              {playbook.stop_pct != null ? ` (${signed(playbook.stop_pct, 2)}%)` : ""}
                            </b>
                            <small className="muted">收盘破此价位说明判断出错，无条件止损</small>
                          </div>
                          <div className="level-item">
                            <span>客观阻力 / 阶段参考目标</span>
                            <b className="num up">
                              T1: {fmt(playbook.target_1, digits)} · T2: {fmt(playbook.target_2, digits)}
                            </b>
                            <small className="muted">20 周期前高前低与 ATR 波动包络测算</small>
                          </div>
                          <div className="level-item">
                            <span>潜在盈亏比 & 建议仓位上限</span>
                            <b className="num">
                              现价 {playbook.rr_now ?? "—"}:1（回踩 {playbook.rr_pullback ?? "—"}:1）
                            </b>
                            <small className="muted">建议仓位：{playbook.position_cap}</small>
                          </div>
                        </div>
                      </>
                    )}

                    <div className="pros-cons-balance">
                      <div className="balance-col bull-col">
                        <h3>支持看多的客观证据</h3>
                        {playbook.bull_points?.length ? (
                          <ul>
                            {playbook.bull_points.map((pt) => (
                              <li key={pt.name}>
                                <b className="up">{pt.name} ({signed(pt.points, 1)}分)</b>：{pt.text}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="muted">当前周期暂无显著多头加分项，买盘信号偏弱。</p>
                        )}
                      </div>
                      <div className="balance-col bear-col">
                        <h3>压制盘面的风险与空头依据</h3>
                        {playbook.bear_points?.length ? (
                          <ul>
                            {playbook.bear_points.map((pt) => (
                              <li key={pt.name}>
                                <b className="down">
                                  {pt.name}{pt.points != null ? ` (${signed(pt.points, 1)}分)` : ""}
                                </b>：{pt.text}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="muted">当前周期暂无显著空头扣分项，但仍需严守下方失效位。</p>
                        )}
                      </div>
                    </div>
                  </div>
                </section>
              ) : (
                <section className="panel">
                  <h2>本周期暂不输出强行打分</h2>
                  <p className="summary">{score.reason || view.error || "暂无读数。"}</p>
                </section>
              )}

              {/* Professional Dual-Mode Chart */}
              <ProChart
                view={view}
                horizon={horizon}
                horizons={horizons}
                onHorizonChange={handleSelectHorizon}
                onLiveTick={handleLiveTick}
                loadingHorizon={loadingHorizon}
                plans={view.horizon_plans}
                synthesis={view.synthesis}
              />

              {/* Macro/Earnings Timeline + Real-time News */}
              <div className="split">
                <section className="panel">
                  <h2>宏观决议与财报时间线（上海时间 UTC+8）</h2>
                  <p className="note">提前锁定美联储 FOMC、CPI、非农与公司财报日，事件前 48 小时系统自动压缩时机分防跳空。</p>
                  <h3 className="subhead">即将到来</h3>
                  <ul className="timeline">
                    {futureEvents.length ? (
                      futureEvents.map((ev) => (
                        <li key={`${ev.kind}-${ev.t}`}>
                          <div className="when">{shanghaiTime(ev.t)} 上海 · 来源 {ev.source}</div>
                          <div>{ev.title}</div>
                          {ev.estimate ? <div className="note">注：该财报日期当前为市场预估窗口。</div> : null}
                        </li>
                      ))
                    ) : (
                      <li>近期暂无已排期的高影响宏观或财报事件。</li>
                    )}
                  </ul>

                  <h3 className="subhead">近期已落地</h3>
                  <ul className="timeline">
                    {pastEvents.map((ev) => (
                      <li key={`past-${ev.kind}-${ev.t}`}>
                        <div className="when">{shanghaiTime(ev.t)} 上海 · {ev.source}</div>
                        <div>{ev.title}</div>
                      </li>
                    ))}
                  </ul>
                </section>

                <section className="panel">
                  <h2>实时标的新闻核对</h2>
                  <p className="note">新闻标题不直接换算成情绪分（防止假消息与标题党诱导），用于人工复核基本面突变。</p>
                  <ul className="news">
                    {(view.news || []).length ? (
                      view.news.slice(0, 10).map((item) => (
                        <li key={item.url}>
                          <div className="when">{shanghaiTime(item.t)} 上海 · {item.source || "资讯"}</div>
                          <a href={item.url} target="_blank" rel="noreferrer">
                            {item.title}
                          </a>
                        </li>
                      ))
                    ) : (
                      <li>正在后台拉取最新新闻，稍后刷新即可查看。</li>
                    )}
                  </ul>
                </section>
              </div>

              {/* BTC Spot ETF Institutional Flows */}
              {view.id === "btc" && view.flows?.length ? (
                <section className="panel">
                  <h2>美国比特币现货 ETF 每日机构资金净流向（百万美元）</h2>
                  <p className="note">
                    正数代表机构净买入流入，负数代表净赎回流出。连续净流出时不宜激进重仓抄底。
                    {view.funding_rate != null
                      ? ` 当前永续合约资金费率：${fmt(view.funding_rate * 100, 4)}% / 8h。`
                      : ""}
                  </p>
                  <table>
                    <thead>
                      <tr>
                        <th>交易日（上海时区）</th>
                        <th className="num">贝莱德 IBIT</th>
                        <th className="num">富达 FBTC</th>
                        <th className="num">全市场 ETF 净流合计</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...view.flows].reverse().map((row) => (
                        <tr key={row.t}>
                          <td>{shanghaiDay(row.t)}</td>
                          <td className={`num ${tone(row.ibit_musd, 0.1)}`}>
                            {row.ibit_musd != null ? signed(row.ibit_musd, 1) : "—"}
                          </td>
                          <td className={`num ${tone(row.fbtc_musd, 0.1)}`}>
                            {row.fbtc_musd != null ? signed(row.fbtc_musd, 1) : "—"}
                          </td>
                          <td className={`num ${tone(row.total_musd, 0.1)}`}>
                            <b>{signed(row.total_musd, 1)}</b>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ) : null}

              {/* 19-Indicator Cross-Validation Breakdown */}
              {score.ok ? (
                <section className="panel">
                  <div className="card-top">
                    <h2>19 项专业指标交叉验证投票明细</h2>
                    <button
                      type="button"
                      className="chip-btn"
                      onClick={() => setShowAllSignals((v) => !v)}
                    >
                      {showAllSignals ? "只看核心前 10 项" : `展开全部 ${(score.signals || []).length} 项指标`}
                    </button>
                  </div>
                  <table>
                    <thead>
                      <tr>
                        <th>指标名称</th>
                        <th>所属维度</th>
                        <th className="num">对方向分贡献</th>
                        <th>实时量化读数与指标优缺点说明</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedSignals.map((sig) => (
                        <tr key={sig.id}>
                          <td><b>{sig.name}</b></td>
                          <td className="muted">{GROUPS[sig.group] || sig.group}</td>
                          <td className={`num points ${tone(sig.points, 0.5)}`}>
                            {sig.points == null ? "样本不足" : signed(sig.points, 1)}
                          </td>
                          <td>
                            <div>{sig.reading}</div>
                            <details>
                              <summary>查看该指标适用场景与盲区</summary>
                              <p>优点：{sig.pros}</p>
                              <p>盲区：{sig.cons}</p>
                            </details>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ) : null}

              <p className="source">
                数据源：加密货币实时 K 线与秒级流来自 Binance (BTCUSDT / HYPEUSDT) 及 Hyperliquid 历史；美股与指数来自 Nasdaq / Yahoo Finance（含 SpaceX 纳斯达克代码 SPCX）；ETF 资金流来自 Bitbo / Farside；宏观日程来自美联储与美国劳工统计局。所有量化评分与价位测算仅供客观决策辅助，不构成收益承诺。
              </p>
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}
