import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { bollinger, compute, ema, sma } from "./indicators.mjs";
import { divergence, evaluate } from "./scoring.mjs";
import { parseBlsReleaseTable, parseFarside, parseFomc } from "./datasources.mjs";
import { nyStamp } from "./time.mjs";
import { isoWeek } from "./week.mjs";

function python(code) {
  return JSON.parse(execFileSync("python3", ["-c", code], { encoding: "utf8" }));
}

function barsFromCloses(closes, volume = 1000) {
  return closes.map((close, i) => ({
    t: 1_700_000_000 + i * 86400,
    o: close * 0.998,
    h: close * 1.01,
    l: close * 0.99,
    c: close,
    v: volume,
  }));
}

function uptrend(n = 260) {
  let price = 100;
  const closes = [];
  for (let i = 0; i < n; i += 1) {
    price *= 1.004;
    closes.push(price);
  }
  return barsFromCloses(closes, 2000);
}

test("ema seed matches python", () => {
  const values = Array.from({ length: 30 }, (_, i) => i + 1);
  const js = ema(values, 10)[9];
  const py = python(`
import json, sys
sys.path.insert(0, "marketdesk")
from engine.indicators import ema
print(json.dumps(ema([float(i) for i in range(1, 31)], 10)[9]))
`);
  assert.ok(Math.abs(js - py) < 1e-9);
  assert.ok(Math.abs(js - sma(values, 10)[9]) < 1e-9);
});

test("bollinger middle matches python", () => {
  const closes = Array.from({ length: 39 }, (_, i) => i + 1);
  const py = python(`
import json, sys
sys.path.insert(0, "marketdesk")
from engine.indicators import bollinger
print(json.dumps(bollinger([float(i) for i in range(1, 40)], 20, 2)[0][-1]))
`);
  assert.ok(Math.abs(bollinger(closes, 20, 2)[0].at(-1) - py) < 1e-9);
});

test("uptrend score matches python", () => {
  const rows = uptrend();
  const context = {
    now: rows.at(-1).t + 86400,
    events: [],
    asset_id: "nvda",
    asset_class: "equity",
    interval_sec: 86400,
    higher_name: "周线",
  };
  const js = evaluate(rows, rows, context);
  const py = python(`
import json, sys
sys.path.insert(0, "marketdesk")
from engine.scoring import evaluate
price = 100.0
closes = []
for _ in range(260):
    price *= 1.004
    closes.append(price)
rows = []
for i, close in enumerate(closes):
    rows.append({"t": 1700000000 + i * 86400, "o": close * 0.998, "h": close * 1.01, "l": close * 0.99, "c": close, "v": 2000})
result = evaluate(rows, rows, {"now": rows[-1]["t"] + 86400, "events": [], "asset_id": "nvda", "asset_class": "equity", "interval_sec": 86400, "higher_name": "周线"})
print(json.dumps({"ok": result["ok"], "regime": result["regime"], "direction": result["direction_score"], "action": result["action_score"], "stance": result["stance"], "execution": result["execution_score"]}))
`);
  assert.equal(js.ok, true);
  assert.equal(js.regime, py.regime);
  assert.equal(js.stance, py.stance);
  assert.ok(Math.abs(js.direction_score - py.direction) < 0.15);
  assert.ok(Math.abs(js.action_score - py.action) < 0.15);
  assert.ok(Math.abs(js.execution_score - py.execution) < 0.15);
});

test("event window caps execution the same way", () => {
  const rows = uptrend();
  const js = evaluate(rows, rows, {
    now: rows.at(-1).t + 3600,
    events: [{ t: rows.at(-1).t + 7200, impact: "high", kind: "cpi", title: "美国 CPI" }],
    asset_id: "nvda",
    asset_class: "equity",
    interval_sec: 86400,
    higher_name: "周线",
  });
  assert.ok(js.execution_score <= 40);
  assert.ok(js.adjustments.some((item) => item.name === "宏观窗口"));
});

test("short history refuses a score", () => {
  const rows = uptrend(40);
  const result = evaluate(rows, null, { now: rows.at(-1).t, events: [], asset_class: "equity" });
  assert.equal(result.ok, false);
});

test("bearish divergence detector matches the fixture", () => {
  const price = Array(60).fill(10);
  const indicator = Array(60).fill(50);
  for (const [center, height, ind] of [[20, 12, 80], [48, 14, 60]]) {
    price[center] = height;
    indicator[center] = ind;
    for (const [step, level] of [[-2, height - 3], [-1, height - 1], [1, height - 1], [2, height - 3]]) {
      price[center + step] = level;
      indicator[center + step] = ind - 5;
    }
  }
  assert.equal(divergence(price, indicator, "bear", 59), true);
});

test("parsers and calendar stamps match python", () => {
  const html = `<table><tr><td>13 Nov 2026</td><td>(143.5)</td><td>0.0</td><td class="x">(185.4)</td></tr></table>`;
  const rows = parseFarside(html);
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(rows[0].total_musd - -185.4) < 1e-9);
  const bls = parseBlsReleaseTable(`<table><tr><td>November 2026</td><td>Dec. 10, 2026</td><td>08:30 AM</td></tr></table>`, "cpi", "美国 CPI");
  assert.equal(bls.length, 1);
  const fomc = parseFomc(`<h4>2026 FOMC Meetings</h4><strong>December</strong><div class="fomc-meeting__date">8-9*</div><h4>2027 FOMC Meetings</h4><strong>January</strong><div class="fomc-meeting__date">26-27</div>`);
  assert.equal(fomc.length, 2);
  assert.match(fomc[0].title, /经济预测/);
  const py = python(`
import json, sys
sys.path.insert(0, "marketdesk")
from engine.datasources import parse_farside, parse_bls_release_table, parse_fomc, _ny
print(json.dumps({
  "flow": parse_farside("""<table><tr><td>13 Nov 2026</td><td>(143.5)</td><td>0.0</td><td class=\\"x\\">(185.4)</td></tr></table>""")[0]["t"],
  "bls": parse_bls_release_table("""<table><tr><td>November 2026</td><td>Dec. 10, 2026</td><td>08:30 AM</td></tr></table>""", "cpi", "美国 CPI")[0]["t"],
  "fomc": [row["t"] for row in parse_fomc("""<h4>2026 FOMC Meetings</h4><strong>December</strong><div class=\\"fomc-meeting__date\\">8-9*</div><h4>2027 FOMC Meetings</h4><strong>January</strong><div class=\\"fomc-meeting__date\\">26-27</div>""")],
  "ny": _ny(2026, 12, 9, 14),
  "week": __import__("engine.bars", fromlist=["iso_week"]).iso_week(1_700_000_000),
}))
`);
  assert.equal(rows[0].t, py.flow);
  assert.equal(bls[0].t, py.bls);
  assert.deepEqual(fomc.map((row) => row.t), py.fomc);
  assert.equal(nyStamp(2026, 12, 9, 14), py.ny);
  assert.deepEqual(isoWeek(1_700_000_000), py.week);
});

test("trend indicators agree on direction", () => {
  const pack = compute(uptrend());
  const rsi = pack.rsi.filter((value) => value != null).at(-1);
  assert.ok(rsi > 70 && rsi <= 100);
  assert.equal(pack.supertrend_dir.at(-1), 1);
  assert.ok(pack.adx.at(-1) > 25);
});
