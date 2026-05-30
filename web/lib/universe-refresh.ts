// DeepSeek-driven universe refresh.
//
// Asks the model to act as a sector curator: given the current watchlist
// and the silicon-civilization-consumption thesis, propose ADDS / REMOVES /
// RECLASSIFIES. Every proposed symbol is validated against pyserver before
// being written (DeepSeek will otherwise hallucinate tickers that don't trade).
import { chat } from "./deepseek";
import { fetchFundamental } from "./pyserver";
import type { UniverseEntry, UniverseFile } from "./universe";
import { readUniverse, writeUniverse } from "./universe";

export interface RefreshProposal {
  adds: UniverseEntry[];
  removes: string[];                       // symbols to drop
  reclassifies: { symbol: string; theme: string }[];
  rationale: string;
}

export interface RefreshResult {
  proposal: RefreshProposal;
  applied: {
    added: UniverseEntry[];
    rejected: { symbol: string; reason: string }[];
    removed: string[];
    reclassified: { symbol: string; from: string; to: string }[];
  };
  finalCount: number;
}

const CURATOR_SYSTEM = `You are a US-equity research curator for the silicon-civilization-consumption theme.

Theme: the things the silicon civilization (the AI compute complex) must
"consume" to exist and expand — compute/AI chips (GPUs/accelerators/CPUs),
optical modules and high-speed interconnect, AI servers, liquid cooling, power
(clean + nuclear), IDC/data centers, HBM/memory, semiconductor equipment and
materials, high-speed PCB, foundry, and cloud.

Task: review the current watchlist, find missing sub-themes and uncovered
leaders, and flag names that should be removed or reclassified.

Requirements:
- Each add must be a real US-listed company (NYSE/Nasdaq). Give the ticker
  (Yahoo style, e.g. NVDA, BRK-B), company name, sub-theme, and a one-line note.
- US tickers only — no A-share 6-digit codes, no Hong Kong (hk-prefixed) codes,
  no other non-US listings.
- Each add must set global_supply (boolean): whether the company is a direct
  supplier into the global AI hardware supply chain. Pure power utilities and
  domestic-only infra are false.
- Prioritize filling "missing leader" sub-themes (e.g. networking, optical
  interconnect, semi equipment, memory/HBM, power for data centers).
- Exclude pure human-consumer names (food, apparel, beverages).
- Reuse the existing sub-theme names where possible (Compute / AI Chips,
  Optical / Interconnect, Networking, AI Servers, Thermal / Power Infra, Power,
  IDC / Data Center, Memory / HBM, Semi Equipment, Semi Materials, Foundry,
  Cloud / AI Infra).

Output STRICT JSON:
{
  "adds": [{"symbol":"...","name":"...","theme":"...","note":"...","global_supply":true|false}, ...],
  "removes": ["symbol", ...],
  "reclassifies": [{"symbol":"...","theme":"new theme"}, ...],
  "rationale": "English, <=300 chars, summarize the main changes and logic"
}
Do not output any other text.`;

export async function proposeRefresh(current: UniverseFile): Promise<RefreshProposal> {
  const userPayload = {
    current_entries: current.entries.map((e) => ({
      symbol: e.symbol,
      name: e.name,
      theme: e.theme,
    })),
    distinct_themes: [...new Set(current.entries.map((e) => e.theme))],
  };
  const raw = await chat(
    [
      { role: "system", content: CURATOR_SYSTEM },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
    { responseFormat: "json_object", temperature: 0.3, bypassCache: true },
  );
  const parsed = JSON.parse(raw) as Partial<RefreshProposal>;
  return {
    adds: parsed.adds ?? [],
    removes: parsed.removes ?? [],
    reclassifies: parsed.reclassifies ?? [],
    rationale: parsed.rationale ?? "",
  };
}

/** A plausible US ticker: 1-5 letters, optional .CLASS / -CLASS suffix. Filters
 *  out A-share 6-digit codes and hk-prefixed Hong Kong codes before validation. */
function isUsTicker(symbol: string): boolean {
  return /^[A-Za-z]{1,5}([.\-][A-Za-z]{1,2})?$/.test(symbol.trim());
}

async function validateSymbol(symbol: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const f = await fetchFundamental(symbol);
    // Even if fields are null, pyserver returned 200 -> the symbol resolved.
    if (!f) return { ok: false, reason: "pyserver returned empty" };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function applyRefresh(
  current: UniverseFile,
  proposal: RefreshProposal,
  opts: { onValidate?: (symbol: string, ok: boolean) => void } = {},
): Promise<RefreshResult> {
  const known = new Map(current.entries.map((e) => [e.symbol, e]));

  // 1. Validate adds in parallel (bounded).
  const added: UniverseEntry[] = [];
  const rejected: { symbol: string; reason: string }[] = [];
  const ADD_CONCURRENCY = 6;
  const nonUsAdds = proposal.adds.filter((a) => a.symbol && !known.has(a.symbol) && !isUsTicker(a.symbol));
  rejected.push(...nonUsAdds.map((a) => ({ symbol: a.symbol, reason: "Only US-listed tickers are allowed in the universe" })));

  const candidates = proposal.adds.filter((a) => a.symbol && !known.has(a.symbol) && isUsTicker(a.symbol));
  for (let i = 0; i < candidates.length; i += ADD_CONCURRENCY) {
    const slice = candidates.slice(i, i + ADD_CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (a) => {
        const v = await validateSymbol(a.symbol);
        opts.onValidate?.(a.symbol, v.ok);
        return { add: a, v };
      }),
    );
    for (const { add, v } of results) {
      if (v.ok) added.push(add);
      else rejected.push({ symbol: add.symbol, reason: v.reason ?? "unknown" });
    }
  }

  // 2. Apply removes (only if currently present).
  const removeSet = new Set(proposal.removes.filter((s) => known.has(s)));

  // 3. Apply reclassifies.
  const reclassMap = new Map(
    proposal.reclassifies
      .filter((r) => known.has(r.symbol) && !removeSet.has(r.symbol))
      .map((r) => [r.symbol, r.theme]),
  );
  const reclassified: { symbol: string; from: string; to: string }[] = [];

  const newEntries: UniverseEntry[] = [];
  for (const e of current.entries) {
    if (removeSet.has(e.symbol)) continue;
    const newTheme = reclassMap.get(e.symbol);
    if (newTheme && newTheme !== e.theme) {
      reclassified.push({ symbol: e.symbol, from: e.theme, to: newTheme });
      newEntries.push({ ...e, theme: newTheme });
    } else {
      newEntries.push(e);
    }
  }
  newEntries.push(...added);

  const next: UniverseFile = {
    ...current,
    updated_at: new Date().toISOString().slice(0, 10),
    updated_by: "deepseek-refresh",
    entries: newEntries,
  };
  writeUniverse(next);

  return {
    proposal,
    applied: { added, rejected, removed: [...removeSet], reclassified },
    finalCount: newEntries.length,
  };
}

export async function refreshUniverse(
  opts: { onValidate?: (symbol: string, ok: boolean) => void } = {},
): Promise<RefreshResult> {
  const current = readUniverse();
  const proposal = await proposeRefresh(current);
  return applyRefresh(current, proposal, opts);
}
