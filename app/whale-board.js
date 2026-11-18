"use client";

import { useEffect, useMemo, useState } from "react";

const THRESHOLDS = [
  { usd: 10_000, label: "1 万" },
  { usd: 20_000, label: "2 万" },
  { usd: 50_000, label: "5 万" },
  { usd: 100_000, label: "10 万" },
];

function money(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const places = abs >= 1000 ? Math.min(digits, 0) : abs >= 1 ? 2 : 4;
  return value.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places });
}

function size(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const places = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return value.toLocaleString("en-US", { maximumFractionDigits: places });
}

function accountLine(account) {
  if (!account) return "";
  const bits = [];
  if (account.accountValue != null) bits.push(`账户权益 ${money(account.accountValue)} USDT`);
  if (account.marginUsed != null) bits.push(`已用保证金 ${money(account.marginUsed)}`);
  if (account.withdrawable != null) bits.push(`可提 ${money(account.withdrawable)}`);
  if (account.leverage != null) bits.push(`${account.leverage}x ${account.leverageType || ""}`.trim());
  if (account.entryPx != null) bits.push(`持仓均价 ${size(account.entryPx)}`);
  if (account.liquidationPx != null) bits.push(`强平价 ${size(account.liquidationPx)}`);
  if (account.positionSize != null) bits.push(`当前仓位 ${size(account.positionSize)}`);
  if (account.unrealizedPnl != null) bits.push(`未实现 ${money(account.unrealizedPnl)}`);
  return bits.join(" · ");
}

export default function WhaleBoard() {
  const [minUsd, setMinUsd] = useState(10_000);
  const [opensOnly, setOpensOnly] = useState(false);
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/whales?min=${minUsd}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`播报接口 ${response.status}`);
        const body = await response.json();
        if (!stopped) {
          setPayload(body);
          setError("");
        }
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : "播报暂时连不上");
      }
    };
    load();
    const timer = setInterval(load, 2500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [minUsd]);

  const rows = useMemo(() => {
    const events = payload?.events || [];
    return opensOnly ? events.filter((event) => event.action === "open") : events;
  }, [payload, opensOnly]);

  const status = payload?.status;
  const opens = (payload?.events || []).filter((event) => event.action === "open").length;
  const closes = (payload?.events || []).filter((event) => event.action === "close").length;

  return (
    <section className="whale-board" aria-label="Hyperliquid 大额开仓播报">
      <div className="whale-head">
        <div>
          <h2>Hyperliquid 大额开仓播报</h2>
          <p className="muted">
            上海时间 · 吃单地址 · 名义金额 · 开多或开空。公开成交只有买和卖，方向以该地址成交记录里的 Open Long / Open Short 为准。
          </p>
        </div>
        <div className="whale-tools">
          {THRESHOLDS.map((item) => (
            <button
              key={item.usd}
              type="button"
              className={`chip-btn${minUsd === item.usd ? " on" : ""}`}
              onClick={() => setMinUsd(item.usd)}
            >
              {item.label}
            </button>
          ))}
          <button
            type="button"
            className={`chip-btn${opensOnly ? " on" : ""}`}
            aria-pressed={opensOnly}
            onClick={() => setOpensOnly((value) => !value)}
          >
            {opensOnly ? "只看开仓" : "开仓和平仓"}
          </button>
        </div>
      </div>

      <div className="whale-status">
        <span className={`whale-dot${status?.connected ? " on" : ""}`} />
        <span>{status?.connected ? `主网已连接 · ${status.coins} 个永续` : "正在连接 Hyperliquid 主网"}</span>
        <span>门槛 {money(minUsd, 0)} USDT</span>
        <span>开仓 {opens} · 平仓 {closes}</span>
        {status?.largestUsd ? <span>听到的最大单笔 {status.largestCoin} {money(status.largestUsd)} USDT</span> : null}
        {status?.queued ? <span>确认队列 {status.queued}</span> : null}
      </div>

      {error ? <p className="whale-error">{error}</p> : null}

      <div className="whale-list" aria-live="polite">
        {rows.length === 0 ? (
          <p className="whale-empty">
            {opensOnly && closes
              ? "这个门槛下还没有确认到新的开仓。关掉「只看开仓」可以看到已经确认的大额平仓。"
              : "正在听成交流。达到门槛的成交会先核对吃单地址的开平方向，确认后出现在这里。"}
          </p>
        ) : rows.map((event) => {
          const href = `https://app.hyperliquid.xyz/explorer/address/${event.address}`;
          const tx = event.hash ? `https://app.hyperliquid.xyz/explorer/tx/${event.hash}` : "";
          const account = accountLine(event.account);
          return (
            <article key={event.id} className={`whale-row ${event.side} ${event.action}`}>
              <div className="whale-time">
                <b>{event.clock}</b>
                <span>上海</span>
              </div>
              <div className={`whale-dir ${event.side}`}>{event.label}</div>
              <div className="whale-main">
                <div className="whale-title">
                  <b>{event.coin}</b>
                  <span>{money(event.notional)} USDT</span>
                  <span className="muted">{size(event.sz)} @ {size(event.px)}</span>
                  <span className="muted">{event.crossed ? "吃单" : "挂单"}</span>
                </div>
                <a className="whale-addr" href={href} target="_blank" rel="noreferrer">
                  {event.address}
                </a>
                <p className="whale-detail">
                  成交前仓位 {size(event.startPosition)} → 成交后 {size(event.endPosition)}
                  {event.fee != null ? ` · 手续费 ${size(event.fee)} USDC` : ""}
                  {event.action === "close" && event.closedPnl != null ? ` · 已实现 ${money(event.closedPnl)}` : ""}
                </p>
                {account ? <p className="whale-account">{account}</p> : null}
              </div>
              {tx ? (
                <a className="whale-hash" href={tx} target="_blank" rel="noreferrer">成交</a>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
