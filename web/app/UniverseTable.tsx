"use client";
import { useEffect, useMemo, useState } from "react";
import type { UniverseEntry } from "@/lib/universe";

interface Analyst {
  symbol: string;
  buy_count?: number | null;
  total_count?: number | null;
  buy_ratio?: number | null;
  consensus_eps_next?: number | null;
  implied_target?: number | null;
  current_price?: number | null;
  upside_pct?: number | null;
}

interface Spot {
  symbol: string;
  price: number;
}

type Row = UniverseEntry & { analyst?: Analyst | null; loading?: boolean };

const ANALYST_BATCH_SIZE = 1;
const ANALYST_BATCH_CONCURRENCY = 8;
const SPOT_BATCH_SIZE = 1000;
const EMPTY_SPOTS: Spot[] = [];

function hasResearchValue(analyst: Analyst): boolean {
  return analyst.buy_count != null
    || analyst.total_count != null
    || analyst.consensus_eps_next != null
    || analyst.implied_target != null
    || analyst.upside_pct != null;
}

async function fetchSpotsFor(symbols: string[]): Promise<Spot[]> {
  try {
    const r = await fetch("/api/spot/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbols }),
    });
    if (!r.ok) return [];
    return (await r.json()) as Spot[];
  } catch {
    return [];
  }
}

async function fetchAnalystsFor(symbols: string[]): Promise<Analyst[]> {
  try {
    const r = await fetch("/api/analyst/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbols }),
    });
    if (!r.ok) return [];
    return (await r.json()) as Analyst[];
  } catch {
    return [];
  }
}

function makeRows(entries: UniverseEntry[], spots: Spot[] = []): Row[] {
  const bySymbol = new Map(spots.map((s) => [s.symbol, s]));
  return entries.map((e) => {
    const spot = bySymbol.get(e.symbol);
    return {
      ...e,
      analyst: spot ? { symbol: e.symbol, current_price: spot.price } : undefined,
      loading: true,
    };
  });
}

function mergeSpots(rows: Row[], spots: Spot[]): Row[] {
  const bySymbol = new Map(spots.map((s) => [s.symbol, s]));
  return rows.map((r) => {
    const spot = bySymbol.get(r.symbol);
    if (!spot) return r;
    return {
      ...r,
      analyst: {
        ...(r.analyst ?? { symbol: r.symbol }),
        current_price: spot.price,
      },
    };
  });
}

function mergeAnalysts(rows: Row[], analysts: Analyst[], batch: string[]): Row[] {
  const bySymbol = new Map(analysts.map((a) => [a.symbol, a]));
  return rows.map((r) => {
    if (!batch.includes(r.symbol)) return r;
    const currentPrice = r.analyst?.current_price;
    const analyst = bySymbol.get(r.symbol);
    if (!analyst) return { ...r, loading: false };
    return {
      ...r,
      analyst: {
        ...analyst,
        current_price: analyst.current_price ?? currentPrice,
      },
      loading: false,
    };
  });
}

export default function UniverseTable({
  entries,
  initialSpots = EMPTY_SPOTS,
}: {
  entries: UniverseEntry[];
  initialSpots?: Spot[];
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    makeRows(entries, initialSpots),
  );
  const [onlyGlobal, setOnlyGlobal] = useState(false);
  const [onlyUpside, setOnlyUpside] = useState(false);
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState("all");
  const [progress, setProgress] = useState(() => ({
    spotDone: initialSpots.length,
    analystDone: 0,
    total: entries.length,
  }));

  // Re-seed when entries prop changes (after refresh).
  useEffect(() => {
    setRows(makeRows(entries, initialSpots));
    setProgress({ spotDone: initialSpots.length, analystDone: 0, total: entries.length });
  }, [entries, initialSpots]);

  // Fetch analyst data in small batches so the table paints prices
  // progressively instead of waiting for the full watchlist.
  useEffect(() => {
    let cancelled = false;
    const symbols = entries.map((e) => e.symbol);
    if (symbols.length === 0) {
      setRows([]);
      return;
    }

    setProgress({
      spotDone: 0,
      analystDone: 0,
      total: symbols.length,
    });

    async function loadSpotInBatches() {
      for (let i = 0; i < symbols.length; i += SPOT_BATCH_SIZE) {
        const batch = symbols.slice(i, i + SPOT_BATCH_SIZE);
        const spots = await fetchSpotsFor(batch);
        if (cancelled) return;
        setProgress((prev) => ({
          ...prev,
          spotDone: Math.min(symbols.length, prev.spotDone + batch.length),
        }));
        setRows((prev) => mergeSpots(prev, spots));
      }
    }
    loadSpotInBatches();

    async function loadInBatches() {
      const batches: string[][] = [];
      for (let i = 0; i < symbols.length; i += ANALYST_BATCH_SIZE) {
        batches.push(symbols.slice(i, i + ANALYST_BATCH_SIZE));
      }
      let nextBatch = 0;
      async function worker() {
        while (!cancelled) {
          const batch = batches[nextBatch++];
          if (!batch) return;
          const analysts = await fetchAnalystsFor(batch);
          if (cancelled) return;
          setProgress((prev) => ({
            ...prev,
            analystDone: Math.min(symbols.length, prev.analystDone + batch.length),
          }));
          setRows((prev) => mergeAnalysts(prev, analysts.filter(hasResearchValue), batch));
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(ANALYST_BATCH_CONCURRENCY, batches.length) }, () => worker()),
      );
    }
    loadInBatches();
    return () => {
      cancelled = true;
    };
  }, [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (onlyGlobal && !r.global_supply) return false;
      if (theme !== "all" && r.theme !== theme) return false;
      if (q && !`${r.symbol} ${r.name} ${r.theme} ${r.note ?? ""}`.toLowerCase().includes(q)) return false;
      if (onlyUpside) {
        const u = r.analyst?.upside_pct;
        if (u === undefined || u === null || u <= 0) return false;
      }
      return true;
    });
  }, [rows, onlyGlobal, onlyUpside, query, theme]);

  const priceCount = rows.filter((r) => r.analyst?.current_price != null).length;
  const ratedCount = rows.filter((r) => r.analyst?.buy_count != null && r.analyst?.total_count).length;
  const upsideCount = rows.filter((r) => (r.analyst?.upside_pct ?? 0) > 0).length;
  const progressTotal = Math.max(progress.total * 2, 1);
  const progressDone = Math.min(progress.spotDone + progress.analystDone, progressTotal);
  const progressPct = Math.round((progressDone / progressTotal) * 100);
  const isFetching = progress.total > 0 && progressDone < progressTotal;
  const themes = useMemo(() => [...new Set(entries.map((e) => e.theme))].sort(), [entries]);
  const grouped = filtered.reduce<Record<string, Row[]>>((acc, r) => {
    (acc[r.theme] ??= []).push(r);
    return acc;
  }, {});

  return (
    <>
      <div className="toolbar">
        <div className="field">
          <span>Search</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ticker, name, theme"
          />
        </div>
        <div className="field">
          <span>Theme</span>
          <select value={theme} onChange={(e) => setTheme(e.target.value)}>
            <option value="all">All themes</option>
            {themes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <label className="check">
          <input type="checkbox" checked={onlyGlobal} onChange={(e) => setOnlyGlobal(e.target.checked)} />
          <span>Global supply chain</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={onlyUpside} onChange={(e) => setOnlyUpside(e.target.checked)} />
          <span>Target above price</span>
        </label>
        <div className="toolbar-status">
          Showing {filtered.length}/{rows.length} · Price {priceCount}/{rows.length} · Rated {ratedCount} · Upside {upsideCount}
        </div>
        <div className="fetch-progress" aria-label="pyserver data load progress">
          <div className="fetch-progress-meta">
            <span>{isFetching ? "Fetching data from pyserver" : "pyserver data loaded"}</span>
            <span>{progressPct}%</span>
          </div>
          <div className="fetch-progress-track">
            <div className="fetch-progress-bar" style={{ width: `${progressPct}%` }} />
          </div>
          <div className="fetch-progress-detail">
            Price {progress.spotDone}/{progress.total} · Target/rating {progress.analystDone}/{progress.total}
          </div>
        </div>
      </div>

      <div className="theme-grid">
        {Object.entries(grouped).map(([theme, items]) => (
          <div key={theme} className="theme-panel">
            <div className="theme-title">
              <strong>{theme}</strong>
              <span>{items.length}</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Name</th>
                    <th>Global</th>
                    <th className="num">Price</th>
                    <th className="num">Target</th>
                    <th className="num">Upside</th>
                    <th className="num">Buy rating</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => {
                    const u = r.analyst?.upside_pct;
                    return (
                      <tr key={r.symbol}>
                        <td className="mono">{r.symbol}</td>
                        <td>
                          <div className="stock-name">{r.name}</div>
                          {r.note && <div className="stock-note">{r.note}</div>}
                        </td>
                        <td>{r.global_supply ? <span className="pill good">Yes</span> : <span className="pill">No</span>}</td>
                        <td className="num">{r.analyst?.current_price?.toFixed(2) ?? (r.loading ? "…" : "—")}</td>
                        <td className="num">{r.analyst?.implied_target?.toFixed(2) ?? (r.loading ? "…" : "—")}</td>
                        <td className={`num ${u == null ? "muted" : u > 0 ? "pos" : "neg"}`}>
                          {u == null ? (r.loading ? "…" : "—") : `${u > 0 ? "+" : ""}${u.toFixed(0)}%`}
                        </td>
                        <td className="num muted">
                          {r.analyst?.buy_count != null && r.analyst?.total_count
                            ? `${r.analyst.buy_count}/${r.analyst.total_count}`
                            : r.loading ? "…" : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
