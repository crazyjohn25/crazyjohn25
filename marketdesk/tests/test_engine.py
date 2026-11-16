"""Indicator identities and the cross-check rules. No network."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.datasources import parse_bls_release_table, parse_farside, parse_fomc
from engine.indicators import bollinger, compute, ema, sma
from engine.scoring import _divergence, evaluate


def bars_from_closes(closes, volume=1_000):
    rows = []
    for i, close in enumerate(closes):
        rows.append(
            {
                "t": 1_700_000_000 + i * 86400,
                "o": close * 0.998,
                "h": close * 1.01,
                "l": close * 0.99,
                "c": close,
                "v": volume,
            }
        )
    return rows


def uptrend(n=260):
    price = 100.0
    closes = []
    for _ in range(n):
        price *= 1.004
        closes.append(price)
    return bars_from_closes(closes, volume=2_000)


class IndicatorTests(unittest.TestCase):
    def test_ema_seed_matches_sma(self):
        values = [float(i) for i in range(1, 31)]
        self.assertAlmostEqual(ema(values, 10)[9], sma(values, 10)[9])

    def test_bollinger_middle_is_sma(self):
        closes = [float(i) for i in range(1, 40)]
        mid, _u, _l, _w, _b = bollinger(closes, 20, 2)
        self.assertAlmostEqual(mid[-1], sma(closes, 20)[-1])

    def test_rsi_stays_in_range_and_rises_with_trend(self):
        pack = compute(uptrend())
        last = [v for v in pack["rsi"] if v is not None][-1]
        self.assertGreater(last, 70)
        self.assertLessEqual(last, 100)

    def test_supertrend_and_adx_agree_on_a_trend(self):
        pack = compute(uptrend())
        self.assertEqual(pack["supertrend_dir"][-1], 1)
        self.assertGreater(pack["adx"][-1], 25)

    def test_flat_market_does_not_crash(self):
        pack = compute(bars_from_closes([50.0] * 120))
        self.assertIsNotNone(pack["rsi"][-1])
        self.assertGreaterEqual(pack["rsi"][-1], 0)
        self.assertLessEqual(pack["rsi"][-1], 100)


class ScoringTests(unittest.TestCase):
    def test_uptrend_leans_long(self):
        rows = uptrend()
        result = evaluate(
            rows,
            rows,
            {"now": rows[-1]["t"] + 86400, "events": [], "asset_id": "nvda", "asset_class": "equity", "interval_sec": 86400, "higher_name": "周线"},
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["regime"], "trend")
        self.assertGreater(result["direction_score"], 35)
        self.assertGreater(result["action_score"], 15)
        self.assertIn(result["stance"], {"trend_long", "trend_long_light"})

    def test_event_window_caps_execution(self):
        rows = uptrend()
        result = evaluate(
            rows,
            rows,
            {
                "now": rows[-1]["t"] + 3600,
                "events": [{"t": rows[-1]["t"] + 7200, "impact": "high", "kind": "cpi", "title": "美国 CPI"}],
                "asset_id": "nvda",
                "asset_class": "equity",
                "interval_sec": 86400,
                "higher_name": "周线",
            },
        )
        self.assertLessEqual(result["execution_score"], 40)
        self.assertTrue(any(item["name"] == "宏观窗口" for item in result["adjustments"]))

    def test_short_history_refuses_a_score(self):
        rows = uptrend(40)
        result = evaluate(rows, None, {"now": rows[-1]["t"], "events": [], "asset_class": "equity"})
        self.assertFalse(result["ok"])

    def test_bearish_divergence_detector(self):
        price = [10.0] * 60
        indicator = [50.0] * 60
        for center, height, ind in ((20, 12, 80), (48, 14, 60)):
            price[center] = height
            indicator[center] = ind
            for step, level in ((-2, height - 3), (-1, height - 1), (1, height - 1), (2, height - 3)):
                price[center + step] = level
                indicator[center + step] = ind - 5
        self.assertTrue(_divergence(price, indicator, "bear", 59))


class ParserTests(unittest.TestCase):
    def test_farside_parentheses_are_outflows(self):
        html = """
        <table><tr><td>13 Nov 2026</td><td>(143.5)</td><td>0.0</td><td class="x">(185.4)</td></tr>
        <tr><td>Total</td><td>1</td></tr></table>
        """
        rows = parse_farside(html)
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(rows[0]["total_musd"], -185.4)

    def test_bls_table(self):
        html = """
        <table><tr><td>November 2026</td><td>Dec. 10, 2026</td><td>08:30 AM</td></tr></table>
        """
        rows = parse_bls_release_table(html, "cpi", "美国 CPI")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["kind"], "cpi")
        self.assertGreater(rows[0]["t"], 1_700_000_000)

    def test_fomc_uses_second_day(self):
        html = """
        <h4>2026 FOMC Meetings</h4>
        <strong>December</strong><div class="fomc-meeting__date">8-9*</div>
        <h4>2027 FOMC Meetings</h4>
        <strong>January</strong><div class="fomc-meeting__date">26-27</div>
        """
        rows = parse_fomc(html)
        titles = [row["title"] for row in rows]
        self.assertEqual(len(rows), 2)
        self.assertIn("经济预测", titles[0])
        december = rows[0]["t"]
        january = rows[1]["t"]
        self.assertLess(december, january)


if __name__ == "__main__":
    unittest.main()
