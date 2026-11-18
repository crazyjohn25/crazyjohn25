"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BINANCE_UM_VIP0,
  closePosition,
  createWallet,
  deposit,
  inspectWallet,
  openPosition,
  openingFee,
  runAutoTrades,
  settleLiquidations,
  withdraw,
} from "../lib/engine/sim-wallet.mjs";

const STORAGE_KEY = "desk-sim-wallet-v1";

function money(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function px(value, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function signed(value) {
  if (!Number.isFinite(Number(value))) return "—";
  const text = money(Math.abs(value));
  if (value > 0) return `+${text}`;
  if (value < 0) return `-${text}`;
  return text;
}

export default function SimWallet({ board, liveAssetId, livePrice }) {
  const [wallet, setWallet] = useState(() => createWallet());
  const [ready, setReady] = useState(false);
  const [auto, setAuto] = useState(false);
  const [assetId, setAssetId] = useState(liveAssetId || "btc");
  const [side, setSide] = useState("long");
  const [leverage, setLeverage] = useState(10);
  const [margin, setMargin] = useState("100");
  const [fundAmount, setFundAmount] = useState("1000");
  const [error, setError] = useState("");
  const [notes, setNotes] = useState([]);
  const quotesRef = useRef([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && Array.isArray(saved.positions) && Number.isFinite(saved.cash)) setWallet(saved);
      }
      if (localStorage.getItem("desk-sim-auto") === "1") setAuto(true);
    } catch {
      // keep the fresh wallet
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(wallet));
  }, [wallet, ready]);

  useEffect(() => {
    if (!ready) return;
    localStorage.setItem("desk-sim-auto", auto ? "1" : "0");
  }, [auto, ready]);

  const quotes = useMemo(() => {
    return (board?.cards || [])
      .filter((card) => card.price != null && card.tradable !== false)
      .map((card) => ({
        id: card.id,
        symbol: card.symbol,
        name: card.name,
        price: card.id === liveAssetId && livePrice != null ? Number(livePrice) : Number(card.price),
        actionScore: Number(card.action_score) || 0,
        digits: card.digits ?? 2,
      }));
  }, [board, liveAssetId, livePrice]);
  quotesRef.current = quotes;

  useEffect(() => {
    if (!ready || !quotes.length) return;
    setWallet((current) => {
      const settled = settleLiquidations(current, quotes, Date.now());
      return settled.notes.length ? settled.wallet : current;
    });
  }, [quotes, ready]);

  const view = useMemo(() => inspectWallet(wallet, quotes), [wallet, quotes]);
  const selected = quotes.find((item) => item.id === assetId) || quotes[0];

  const runAi = () => {
    const currentQuotes = quotesRef.current;
    if (!currentQuotes.length) {
      setError("行情还没到，AI 暂时不能开仓");
      return;
    }
    let taken = [];
    setWallet((current) => {
      const settled = settleLiquidations(current, currentQuotes, Date.now());
      const traded = runAutoTrades(settled.wallet, currentQuotes, Math.random, Date.now());
      taken = [...settled.notes, ...traded.notes];
      return traded.wallet;
    });
    setNotes(taken.length ? taken : ["这一轮没有成交。AI 仍会在下一轮按分数和随机数继续试。"]);
    setError("");
  };

  useEffect(() => {
    if (!auto || !ready) return undefined;
    const timer = setInterval(runAi, 12000);
    return () => clearInterval(timer);
  }, [auto, ready]);

  const apply = (result) => {
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setWallet(result.wallet);
    setError("");
    setNotes(result.wallet.fills[0] ? [result.wallet.fills[0].note] : []);
  };

  const marginNum = Number(margin);
  const feePreview = selected && Number.isFinite(marginNum) && marginNum > 0
    ? openingFee(marginNum, leverage)
    : null;
  const notional = Number.isFinite(marginNum) ? marginNum * leverage : null;

  return (
    <section className="panel sim-wallet" aria-label="模拟合约钱包">
      <div className="sim-head">
        <div>
          <h2>模拟合约钱包</h2>
          <p className="note">{BINANCE_UM_VIP0.label}。资金只存在这台浏览器里，不会下到真实交易所。</p>
        </div>
        <button
          type="button"
          className={`chip-btn sim-auto${auto ? " on" : ""}`}
          onClick={() => {
            setAuto((value) => !value);
            if (!auto) runAi();
          }}
        >
          {auto ? "AI 正在自动开平仓" : "启动 AI 自动交易"}
        </button>
      </div>

      <div className="sim-stats">
        <div>
          <span>权益</span>
          <b>{money(view.equity)}</b>
        </div>
        <div>
          <span>可用</span>
          <b>{money(view.cash)}</b>
        </div>
        <div>
          <span>保证金</span>
          <b>{money(view.locked)}</b>
        </div>
        <div>
          <span>未实现盈亏</span>
          <b className={view.upnl > 0 ? "up" : view.upnl < 0 ? "down" : ""}>{signed(view.upnl)}</b>
        </div>
        <div>
          <span>已实现</span>
          <b className={view.realized > 0 ? "up" : view.realized < 0 ? "down" : ""}>{signed(view.realized)}</b>
        </div>
        <div>
          <span>累计手续费</span>
          <b>{money(view.fees)}</b>
        </div>
      </div>

      <p className="note sim-goal">
        AI 的目标是把权益做高。它不设开仓门槛，也不限制杠杆和持仓个数，最高 100 倍。分数明显时顺分数开，分数接近 0 就随机做多或做空；杠杆和保证金每次随机。浮盈会偏向落袋，分数反向会偏向平仓。
      </p>

      <div className="sim-forms">
        <form
          className="sim-form"
          onSubmit={(event) => {
            event.preventDefault();
            apply(deposit(wallet, fundAmount, Date.now()));
          }}
        >
          <b>资金</b>
          <input
            className="sim-input"
            inputMode="decimal"
            aria-label="资金金额"
            value={fundAmount}
            onChange={(event) => setFundAmount(event.target.value)}
          />
          <button type="submit" className="chip-btn">增加资金</button>
          <button
            type="button"
            className="chip-btn"
            onClick={() => apply(withdraw(wallet, fundAmount, Date.now()))}
          >
            减少资金
          </button>
        </form>

        <form
          className="sim-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!selected) {
              setError("没有可交易的行情");
              return;
            }
            apply(openPosition(wallet, {
              assetId: selected.id,
              symbol: selected.symbol,
              name: selected.name,
              side,
              leverage,
              margin: marginNum,
              price: selected.price,
              nonce: `${Date.now()}`,
            }, Date.now()));
          }}
        >
          <b>开仓</b>
          <select
            className="sim-input"
            aria-label="合约标的"
            value={selected?.id || ""}
            onChange={(event) => setAssetId(event.target.value)}
          >
            {quotes.map((item) => (
              <option key={item.id} value={item.id}>{item.name} {item.symbol}</option>
            ))}
          </select>
          <select className="sim-input" aria-label="方向" value={side} onChange={(event) => setSide(event.target.value)}>
            <option value="long">做多</option>
            <option value="short">做空</option>
          </select>
          <label className="sim-lev">
            {leverage}x
            <input
              type="range"
              min="1"
              max="100"
              value={leverage}
              aria-label="杠杆"
              onChange={(event) => setLeverage(Number(event.target.value))}
            />
          </label>
          <input
            className="sim-input"
            inputMode="decimal"
            aria-label="保证金"
            value={margin}
            onChange={(event) => setMargin(event.target.value)}
          />
          <button type="submit" className="chip-btn on">市价开仓</button>
        </form>
      </div>
      {selected && feePreview != null ? (
        <p className="note">
          {selected.symbol} 现价 {px(selected.price, selected.digits)}。名义价值 {money(notional)} USDT，开仓吃单手续费 {money(feePreview)} USDT
          {notional != null && marginNum > 0 ? `（保证金的 ${((feePreview / marginNum) * 100).toFixed(2)}%）` : ""}。
        </p>
      ) : null}
      {error ? <p className="warn">{error}</p> : null}
      {notes.length ? (
        <ul className="sim-notes">
          {notes.slice(0, 4).map((note) => <li key={note}>{note}</li>)}
        </ul>
      ) : null}

      <div className="sim-table-wrap">
        <table>
          <thead>
            <tr>
              <th>仓位</th>
              <th className="num">杠杆</th>
              <th className="num">开仓价</th>
              <th className="num">标记价</th>
              <th className="num">强平价</th>
              <th className="num">未实现</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {view.positions.length ? view.positions.map((position) => {
              const digits = quotes.find((item) => item.id === position.assetId)?.digits ?? 2;
              return (
                <tr key={position.id}>
                  <td>
                    <b>{position.symbol}</b>
                    <span className={position.side === "long" ? "up" : "down"}>
                      {position.side === "long" ? " 多" : " 空"}
                    </span>
                  </td>
                  <td className="num">{position.leverage}x</td>
                  <td className="num">{px(position.entry, digits)}</td>
                  <td className="num">{px(position.mark, digits)}</td>
                  <td className="num">{px(position.liq, digits)}</td>
                  <td className={`num ${position.upnl > 0 ? "up" : position.upnl < 0 ? "down" : ""}`}>
                    {signed(position.upnl)}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="chip-btn"
                      onClick={() => apply(closePosition(wallet, position.id, position.mark, Date.now()))}
                    >
                      平仓
                    </button>
                  </td>
                </tr>
              );
            }) : (
              <tr>
                <td colSpan={7} className="muted">还没有合约仓位。可以自己开，也可以让 AI 按盘面随机开。</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
