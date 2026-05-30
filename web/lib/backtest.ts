// Bar-by-bar backtest engine. Walks the price series forward, asks DeepSeek
// for signals every `rebalanceEveryNDays` bars using only data available at
// that point (look-ahead-free), and applies them to a virtual portfolio.
//
// Signals are cached by (model, messages) hash, so re-running the same
// backtest is free in tokens — only adding new bars or symbols pays cost.
import type { Kline } from "./pyserver";
import { scoreSymbols, type SymbolSnapshot, type Signal } from "./deepseek";
import type { UniverseEntry } from "./universe";

export interface BacktestConfig {
  startCash: number;
  rebalanceEveryNDays: number;
  startDate: string;         // YYYY-MM-DD
  endDate: string;
  feeBps: number;            // round-trip in basis points
  maxPositions: number;
}

export interface PortfolioBar {
  date: string;
  equity: number;
  cash: number;
  positions: Record<string, { shares: number; price: number }>;
}

export interface BacktestResult {
  config: BacktestConfig;
  equityCurve: PortfolioBar[];
  trades: Array<{
    date: string;
    symbol: string;
    side: "buy" | "sell";
    shares: number;
    price: number;
  }>;
  signalsByDate: Record<string, Signal[]>;
  stats: {
    totalReturnPct: number;
    cagrPct: number;
    maxDrawdownPct: number;
    sharpe: number;
    trades: number;
  };
}

export interface SymbolSeries {
  entry: UniverseEntry;
  klines: Kline[];
  fundamental?: SymbolSnapshot["fundamental"];
}

function alignedTradingDates(series: SymbolSeries[]): string[] {
  const sets = series.map((s) => new Set(s.klines.map((k) => k.date)));
  const all = new Set<string>();
  series.forEach((s) => s.klines.forEach((k) => all.add(k.date)));
  // intersection — only dates present in all series, to keep portfolio aligned
  return [...all]
    .filter((d) => sets.every((s) => s.has(d)))
    .sort();
}

function indexByDate(klines: Kline[]) {
  const m = new Map<string, Kline>();
  for (const k of klines) m.set(k.date, k);
  return m;
}

export type Progress =
  | { phase: "signals"; done: number; total: number }
  | { phase: "simulating"; done: number; total: number };

export type Scorer = (
  snapshots: SymbolSnapshot[],
  opts: { asOf: string; mode: "backtest" },
) => Promise<Signal[]>;

export interface RunBacktestOptions {
  onProgress?: (p: Progress) => void;
  /** Override the LLM scorer — used by tests to inject deterministic signals. */
  scorer?: Scorer;
}

export async function runBacktest(
  series: SymbolSeries[],
  cfg: BacktestConfig,
  optsOrOnProgress?: RunBacktestOptions | ((p: Progress) => void),
): Promise<BacktestResult> {
  const opts: RunBacktestOptions = typeof optsOrOnProgress === "function"
    ? { onProgress: optsOrOnProgress }
    : (optsOrOnProgress ?? {});
  const onProgress = opts.onProgress;
  const scorer: Scorer = opts.scorer ?? scoreSymbols;
  const dates = alignedTradingDates(series).filter(
    (d) => d >= cfg.startDate && d <= cfg.endDate,
  );
  if (dates.length < 5) {
    throw new Error(`Not enough aligned trading days (${dates.length}) in window`);
  }

  const byDate = series.map((s) => indexByDate(s.klines));
  const symbols = series.map((s) => s.entry.symbol);

  const t0 = Date.now();
  // Pre-fetch ALL rebalance signals in parallel. Signals at date D depend
  // only on price history <= D, never on what we held — independent calls.
  // Cached entries return instantly; uncached fire concurrently (bounded).
  const rebalanceDates = dates.filter((_, i) => i % cfg.rebalanceEveryNDays === 0);
  const signalsByDate: Record<string, Signal[]> = {};
  const CONCURRENCY = 6;
  let signalsDone = 0;
  onProgress?.({ phase: "signals", done: 0, total: rebalanceDates.length });
  for (let i = 0; i < rebalanceDates.length; i += CONCURRENCY) {
    const slice = rebalanceDates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (d) => {
        const snapshots: SymbolSnapshot[] = series.map((s) => {
          const upto = s.klines.filter((k) => k.date <= d);
          return {
            symbol: s.entry.symbol,
            name: s.entry.name,
            theme: s.entry.theme,
            closes: upto.map((k) => k.close),
            fundamental: s.fundamental,
          };
        });
        const sigs = await scorer(snapshots, { asOf: d, mode: "backtest" });
        signalsDone++;
        onProgress?.({ phase: "signals", done: signalsDone, total: rebalanceDates.length });
        return [d, sigs] as const;
      }),
    );
    for (const [d, sigs] of results) signalsByDate[d] = sigs;
  }
  console.log(
    `[backtest] fetched ${rebalanceDates.length} rebalance signals in ${
      ((Date.now() - t0) / 1000).toFixed(1)
    }s (concurrency=${CONCURRENCY})`,
  );

  let cash = cfg.startCash;
  const shares: Record<string, number> = Object.fromEntries(symbols.map((s) => [s, 0]));
  const equityCurve: PortfolioBar[] = [];
  const trades: BacktestResult["trades"] = [];
  const fee = cfg.feeBps / 10_000;

  const progressEvery = Math.max(1, Math.floor(dates.length / 20));
  onProgress?.({ phase: "simulating", done: 0, total: dates.length });
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    if (i % progressEvery === 0 || i === dates.length - 1) {
      onProgress?.({ phase: "simulating", done: i + 1, total: dates.length });
    }
    const prices: Record<string, number> = {};
    for (let j = 0; j < symbols.length; j++) {
      const k = byDate[j].get(date)!;
      prices[symbols[j]] = k.close;
    }

    // Rebalance day?
    if (i % cfg.rebalanceEveryNDays === 0) {
      const signals = signalsByDate[date] ?? [];

      // Sells first to free cash. US equities have no daily price limit, so a
      // signaled exit always fills at the close.
      for (const sig of signals) {
        if (sig.action !== "sell") continue;
        const held = shares[sig.symbol] ?? 0;
        if (held <= 0) continue;
        const px = prices[sig.symbol];
        cash += held * px * (1 - fee);
        trades.push({ date, symbol: sig.symbol, side: "sell", shares: held, price: px });
        shares[sig.symbol] = 0;
      }

      // Rank buys by confidence*size, cap at maxPositions.
      const buys = signals
        .filter((s) => s.action === "buy" && s.size > 0)
        .sort((a, b) => b.confidence * b.size - a.confidence * a.size)
        .slice(0, cfg.maxPositions);

      const totalWeight = buys.reduce((sum, s) => sum + s.size * s.confidence, 0) || 1;
      const budget = cash;
      for (const sig of buys) {
        const weight = (sig.size * sig.confidence) / totalWeight;
        const alloc = budget * weight;
        const px = prices[sig.symbol];
        if (!px || alloc <= 0) continue;
        const sh = Math.floor(alloc / (px * (1 + fee))); // whole shares (US)
        if (sh <= 0) continue;
        const cost = sh * px * (1 + fee);
        if (cost > cash) continue;
        cash -= cost;
        shares[sig.symbol] = (shares[sig.symbol] ?? 0) + sh;
        trades.push({ date, symbol: sig.symbol, side: "buy", shares: sh, price: px });
      }
    }

    // Mark-to-market
    let equity = cash;
    const positions: PortfolioBar["positions"] = {};
    for (const sym of symbols) {
      if (shares[sym] > 0) {
        const px = prices[sym];
        equity += shares[sym] * px;
        positions[sym] = { shares: shares[sym], price: px };
      }
    }
    equityCurve.push({ date, equity, cash, positions });
  }

  // Stats
  const equities = equityCurve.map((b) => b.equity);
  const start = equities[0];
  const end = equities[equities.length - 1];
  const totalReturnPct = (end / start - 1) * 100;
  const years = equityCurve.length / 252;
  const cagrPct = (Math.pow(end / start, 1 / Math.max(years, 1 / 252)) - 1) * 100;

  let peak = start;
  let maxDD = 0;
  for (const e of equities) {
    peak = Math.max(peak, e);
    maxDD = Math.min(maxDD, e / peak - 1);
  }

  const rets: number[] = [];
  for (let i = 1; i < equities.length; i++) {
    rets.push(equities[i] / equities[i - 1] - 1);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance =
    rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  return {
    config: cfg,
    equityCurve,
    trades,
    signalsByDate,
    stats: {
      totalReturnPct,
      cagrPct,
      maxDrawdownPct: maxDD * 100,
      sharpe,
      trades: trades.length,
    },
  };
}
