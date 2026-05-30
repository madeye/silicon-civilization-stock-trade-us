// Real backtest exercise with deterministic injected scorer.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Cache backend writes under cwd/.cache; sandbox it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scc-bt-"));
process.chdir(tmp);

import type { Kline } from "../lib/pyserver";
import { runBacktest, type SymbolSeries, type Progress, type BacktestConfig, type Scorer } from "../lib/backtest";

// Deterministic scorer: always BUY A, SELL B with full size.
const scorer: Scorer = async (snapshots) =>
  snapshots.map((s) => ({
    symbol: s.symbol,
    action: s.symbol === "A" ? "buy" : "sell",
    confidence: 1,
    size: s.symbol === "A" ? 1 : 0,
    rationale: "test",
  }));

function makeKlines(start: string, closes: number[]): Kline[] {
  const d = new Date(start);
  return closes.map((c) => {
    // Skip weekends to mimic trading days.
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
      d.setUTCDate(d.getUTCDate() + 1);
    }
    const date = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
    return { date, open: c, high: c, low: c, close: c, volume: 1_000_000 };
  });
}

function makeSeries(): SymbolSeries[] {
  // A trends up (100→150), B trends down (100→70).
  const aCloses = Array.from({ length: 80 }, (_, i) => 100 + i * 0.625);
  const bCloses = Array.from({ length: 80 }, (_, i) => 100 - i * 0.375);
  return [
    { entry: { symbol: "A", name: "Up", theme: "T" }, klines: makeKlines("2025-01-01", aCloses) },
    { entry: { symbol: "B", name: "Down", theme: "T" }, klines: makeKlines("2025-01-01", bCloses) },
  ];
}

const cfg: BacktestConfig = {
  startCash: 1_000_000,
  rebalanceEveryNDays: 5,
  // dates from makeSeries start at 2025-01-01 (UTC); first business day is 01-01.
  startDate: "2025-01-01",
  endDate: "2025-12-31",
  feeBps: 0,
  maxPositions: 5,
};

test("runBacktest produces a result with expected shape", async () => {
  const r = await runBacktest(makeSeries(), cfg, { scorer });
  assert.ok(r.equityCurve.length > 30);
  assert.ok(r.trades.length > 0);
  assert.ok(typeof r.stats.totalReturnPct === "number");
  assert.ok(typeof r.stats.maxDrawdownPct === "number");
});

test("backtest buys the up-trending symbol", async () => {
  const r = await runBacktest(makeSeries(), cfg, { scorer });
  const buys = r.trades.filter((t) => t.side === "buy");
  assert.ok(buys.length > 0, "expected at least one buy");
  assert.ok(buys.every((t) => t.symbol === "A"), "should only buy A (up trender)");
});

test("equity is monotonically tracking the chosen asset (no losses on uptrend)", async () => {
  const r = await runBacktest(makeSeries(), cfg, { scorer });
  const start = r.equityCurve[0].equity;
  const end = r.equityCurve.at(-1)!.equity;
  assert.ok(end > start, `expected end (${end}) > start (${start}) when buying uptrend`);
  // Total return should be positive and substantial — A goes 100→150 = +50%, we
  // capture most of it after the first rebalance lag.
  assert.ok(r.stats.totalReturnPct > 20, `got ${r.stats.totalReturnPct}%`);
});

test("progress callback fires for signals + simulating phases", async () => {
  const events: Progress[] = [];
  await runBacktest(makeSeries(), cfg, { scorer, onProgress: (p) => events.push(p) });
  const phases = new Set(events.map((e) => e.phase));
  assert.ok(phases.has("signals"), "expected signals events");
  assert.ok(phases.has("simulating"), "expected simulating events");
  // First and last simulating events should bracket [0, N].
  const sim = events.filter((e) => e.phase === "simulating");
  assert.equal(sim[0].done, 0);
  assert.equal(sim.at(-1)!.done, sim.at(-1)!.total);
});

test("throws when window has too few aligned trading days", async () => {
  const tinyCfg = { ...cfg, startDate: "2025-12-29", endDate: "2025-12-31" };
  await assert.rejects(() => runBacktest(makeSeries(), tinyCfg, { scorer }), /aligned/i);
});

// --- US-market tradability: no daily price limits ---------------------------

// Trading-day dates generated the same way makeKlines does, so tests can refer
// to the date at a given bar index.
function tradingDates(start: string, n: number): string[] {
  const d = new Date(start);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function flatWithJump(start: string, n: number, jumpIndex: number, jumpClose: number, base = 10): Kline[] {
  const closes = Array.from({ length: n }, (_, i) => (i < jumpIndex ? base : jumpClose));
  return makeKlines(start, closes);
}

// Rebalances land on bar indices 0, 5, 10, … (every 5).
const N = 60;
const dates = tradingDates("2025-01-01", N);

test("fills a buy on a large up-gap (US has no limit-up lock)", async () => {
  // +15% jump at bar 5 — in the US there is no daily price-limit lock, so the
  // buy fills at the close like any other bar.
  const series: SymbolSeries[] = [
    { entry: { symbol: "NVDA", name: "X", theme: "T" }, klines: flatWithJump("2025-01-01", N, 5, 11.5) },
  ];
  const buyOnBar5: Scorer = async (snaps, { asOf }) =>
    snaps.map((s) => ({
      symbol: s.symbol,
      action: asOf === dates[5] ? "buy" : "hold",
      confidence: 1,
      size: asOf === dates[5] ? 1 : 0,
      rationale: "t",
    }));
  const r = await runBacktest(series, cfg, { scorer: buyOnBar5 });
  const buys = r.trades.filter((t) => t.side === "buy");
  assert.equal(buys.length, 1, "a large up-gap is still buyable in the US");
  assert.equal(buys[0].date, dates[5]);
  assert.equal(buys[0].price, 11.5);
});

test("sells same-day on a large down-gap (US has no limit-down lock)", async () => {
  // Buy at bar 0 (price 10), then bar 5 gaps -15% and holds flat after. With no
  // US price limit the sell executes at bar 5, not deferred.
  const closes = Array.from({ length: N }, (_, i) => (i < 5 ? 10 : 8.5));
  const series: SymbolSeries[] = [
    { entry: { symbol: "NVDA", name: "X", theme: "T" }, klines: makeKlines("2025-01-01", closes) },
  ];
  const buyThenSell: Scorer = async (snaps, { asOf }) =>
    snaps.map((s) => ({
      symbol: s.symbol,
      action: asOf === dates[0] ? "buy" : asOf === dates[5] ? "sell" : "hold",
      confidence: 1,
      size: asOf === dates[0] ? 1 : 0,
      rationale: "t",
    }));
  const r = await runBacktest(series, cfg, { scorer: buyThenSell });
  const sells = r.trades.filter((t) => t.side === "sell");
  assert.equal(sells.length, 1, "exactly one sell, executed same day");
  assert.equal(sells[0].date, dates[5], "sell fills on the signal day, no deferral");
  assert.equal(sells[0].price, 8.5);
});
