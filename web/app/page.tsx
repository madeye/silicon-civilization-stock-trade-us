import Link from "next/link";
import { readUniverse } from "@/lib/universe";
import RefreshUniverseButton from "./RefreshUniverseButton";
import UniverseTable from "./UniverseTable";

export const dynamic = "force-dynamic";

export default function Home() {
  const universe = readUniverse();
  const entries = universe.entries;
  const globalCount = entries.filter((e) => e.global_supply).length;
  const themeCount = new Set(entries.map((e) => e.theme)).size;

  return (
    <div className="container">
      <header className="page-header">
        <div>
          <div className="eyebrow">DeepSeek · Yahoo Finance · US Equities</div>
          <h1>Silicon Civilization Stocks</h1>
          <p>
            Tracking the supply side of AI: compute chips, optical/interconnect, AI servers, liquid cooling, power, data centers, memory, and semiconductor equipment & materials.
          </p>
        </div>
        <div className="header-actions">
          <Link href="/signals" className="button secondary">Live Signals</Link>
          <Link href="/backtest" className="button secondary">Backtest</Link>
        </div>
      </header>

      <div className="summary-grid">
        <div className="metric">
          <span className="label">Watchlist</span>
          <strong>{entries.length}</strong>
          <span>US equities</span>
        </div>
        <div className="metric">
          <span className="label">Global supply chain</span>
          <strong>{globalCount}</strong>
          <span>{Math.round((globalCount / Math.max(entries.length, 1)) * 100)}% coverage</span>
        </div>
        <div className="metric">
          <span className="label">Sub-themes</span>
          <strong>{themeCount}</strong>
          <span>grouped by supply-chain layer</span>
        </div>
        <div className="metric">
          <span className="label">Updated</span>
          <strong>{universe.updated_at}</strong>
          <span>{universe.updated_by}</span>
        </div>
      </div>

      <div className="section-heading">
        <div>
          <h2>Watchlist</h2>
          <p>Filter, and view ratings, price targets, and upside.</p>
        </div>
        <RefreshUniverseButton />
      </div>

      <UniverseTable entries={entries} />
    </div>
  );
}
