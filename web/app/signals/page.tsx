import { loadEntries } from "@/lib/universe";
import { fetchKlines, fetchFundamental, fetchSpot } from "@/lib/pyserver";
import { scoreSymbols, type SymbolSnapshot } from "@/lib/deepseek";
import Link from "next/link";

export const dynamic = "force-dynamic";

type LiveSnapshot = SymbolSnapshot & { spotPrice?: number };

function calcPeg(pe?: number | null, profitYoyPct?: number | null) {
  if (pe == null || profitYoyPct == null || pe <= 0 || profitYoyPct <= 0) {
    return null;
  }
  return pe / profitYoyPct;
}

async function loadSignals() {
  const universe = loadEntries();
  const start = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return d.toISOString().slice(0, 10);
  })();

  const snapshots: LiveSnapshot[] = await Promise.all(
    universe.map(async (e) => {
      const [klines, fund, spot] = await Promise.all([
        fetchKlines(e.symbol, start).catch(() => []),
        fetchFundamental(e.symbol).catch(() => undefined),
        fetchSpot(e.symbol).catch(() => undefined),
      ]);
      return {
        symbol: e.symbol,
        name: e.name,
        theme: e.theme,
        spotPrice: spot?.price,
        closes: klines.map((k) => k.close),
        fundamental: fund
          ? {
              pe_ttm: fund.pe_ttm,
              pb: fund.pb,
              market_cap: fund.market_cap,
              profit_yoy: fund.profit_yoy,
            }
          : undefined,
      };
    }),
  );

  const usable = snapshots.filter((s) => s.closes.length >= 10);
  const signals = await scoreSymbols(usable);
  const byId = new Map(signals.map((s) => [s.symbol, s]));

  return universe.map((e) => ({
    entry: e,
    snapshot: snapshots.find((s) => s.symbol === e.symbol),
    signal: byId.get(e.symbol),
  }));
}

export default async function SignalsPage() {
  let rows: Awaited<ReturnType<typeof loadSignals>> = [];
  let error: string | null = null;
  try {
    rows = await loadSignals();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="container">
      <Link href="/" className="back-link">Back to watchlist</Link>
      <header className="page-header compact">
        <div>
          <div className="eyebrow">Live scoring</div>
          <h1>Live Signals</h1>
          <p>Weighted toward PEG and earnings growth / valuation fit, with short-term price signals down-weighted, producing 5-20 trading-day action calls.</p>
        </div>
      </header>
      {error && (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          <strong>Load failed:</strong> {error}
          <p style={{ color: "var(--muted)" }}>
            Confirm pyserver is running at <code>{process.env.PYSERVER_URL ?? "http://localhost:8001"}</code>{" "}
            and that <code>DEEPSEEK_API_KEY</code> is set.
          </p>
        </div>
      )}
      {!error && (
        <div className="theme-panel">
          <div className="theme-title">
            <strong>Signals</strong>
            <span>{rows.filter((r) => r.signal?.action === "buy").length} buy · {rows.filter((r) => r.signal?.action === "sell").length} sell</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Name</th>
                  <th>Theme</th>
                  <th>Action</th>
                  <th className="num">Price</th>
                  <th className="num">Confidence</th>
                  <th className="num">Size</th>
                  <th className="num">PE(TTM)</th>
                  <th className="num">Profit YoY</th>
                  <th className="num">PEG</th>
                  <th>Rationale</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ entry, signal, snapshot }) => (
                  <tr key={entry.symbol}>
                    <td className="mono">{entry.symbol}</td>
                    <td>{entry.name}</td>
                    <td>{entry.theme}</td>
                    <td>
                      {signal ? (
                        <span className={`badge ${signal.action}`}>{signal.action}</span>
                      ) : (
                        <span className="badge">n/a</span>
                      )}
                    </td>
                    <td className="num">{snapshot?.spotPrice?.toFixed(2) ?? snapshot?.closes.at(-1)?.toFixed(2) ?? "—"}</td>
                    <td className="num">{signal ? (signal.confidence * 100).toFixed(0) + "%" : "—"}</td>
                    <td className="num">{signal ? (signal.size * 100).toFixed(0) + "%" : "—"}</td>
                    <td className="num">{snapshot?.fundamental?.pe_ttm?.toFixed(1) ?? "—"}</td>
                    <td className="num">{snapshot?.fundamental?.profit_yoy != null ? `${snapshot.fundamental.profit_yoy.toFixed(1)}%` : "—"}</td>
                    <td className="num">{calcPeg(snapshot?.fundamental?.pe_ttm, snapshot?.fundamental?.profit_yoy)?.toFixed(2) ?? "—"}</td>
                    <td className="muted signal-reason">{signal?.rationale ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
