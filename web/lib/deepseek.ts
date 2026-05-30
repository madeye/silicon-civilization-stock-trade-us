// DeepSeek v4 client with aggressive caching.
//
// API-frugality strategy:
//   1. SQLite-cache every (model, messages) tuple for 12h by default.
//   2. Batch multi-symbol scoring into ONE prompt with JSON-array output.
//   3. Stable system prompt sits at messages[0] so DeepSeek's own server-side
//      KV-cache (free) hits on every rebalance during a backtest.
//   4. Backtest mode: never set bypassCache — historical bars are deterministic,
//      so the first run pays the token cost and every subsequent run is free.
//   5. `DEEPSEEK_MODEL_BACKTEST` overrides the model for backtest sweeps —
//      default to v4-flash there to halve token spend on large windows.
import { cached } from "./cache";

const API_KEY = process.env.DEEPSEEK_API_KEY;
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro";
const BACKTEST_MODEL = process.env.DEEPSEEK_MODEL_BACKTEST ?? "deepseek-v4-flash";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  responseFormat?: "json_object" | "text";
  ttlSeconds?: number;
  bypassCache?: boolean;
}

export async function chat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  if (!API_KEY) throw new Error("DEEPSEEK_API_KEY is not set");
  const model = opts.model ?? MODEL;
  const temperature = opts.temperature ?? 0.2;
  const responseFormat = opts.responseFormat ?? "text";
  const ttl = opts.ttlSeconds ?? 12 * 3600;

  const cacheParts = { model, temperature, responseFormat, messages };
  const doFetch = async () => {
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature,
      stream: false,
    };
    if (responseFormat === "json_object") {
      body.response_format = { type: "json_object" };
    }
    const r = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      throw new Error(`deepseek ${r.status}: ${await r.text()}`);
    }
    const j = (await r.json()) as {
      choices: { message: { content: string } }[];
    };
    return j.choices[0]?.message?.content ?? "";
  };

  if (opts.bypassCache) return doFetch();
  return cached(cacheParts, ttl, doFetch);
}

// ----- Strategy-specific helpers ------------------------------------------

export interface SymbolSnapshot {
  symbol: string;
  name?: string | null;
  theme?: string;
  closes: number[];      // last ~60 daily closes, oldest first
  fundamental?: {
    pe_ttm?: number | null;
    pb?: number | null;
    market_cap?: number | null;
    profit_yoy?: number | null;
  };
}

export interface Signal {
  symbol: string;
  action: "buy" | "hold" | "sell";
  confidence: number;    // 0..1
  size: number;          // 0..1 fraction of available capital
  rationale: string;
}

function calcPeg(pe?: number | null, profitYoyPct?: number | null): number | null {
  if (pe == null || profitYoyPct == null || pe <= 0 || profitYoyPct <= 0) {
    return null;
  }
  return Number((pe / profitYoyPct).toFixed(3));
}

const STRATEGY_SYSTEM = `You are a quantitative strategist for the US market focused on the "silicon
civilization consumption" theme.

Theme: treat AI / silicon civilization as an emerging civilization whose own
"consumption" is not human goods but the inputs that let compute exist and
expand — AI/compute chips (GPUs, accelerators, CPUs), optical modules and
high-speed interconnect, AI servers, liquid cooling, power (especially clean
and nuclear), IDC/data centers, HBM/memory, semiconductor equipment and
materials, high-speed PCB, foundry, and cloud. We go long the "sellers of
shovels" that feed this silicon civilization.

Task: given recent price series and fundamental snapshots for a set of these
names, output trade actions for a 5-20 trading-day horizon. Balance three
dimensions: fundamental valuation (PEG / earnings growth / valuation fit),
thematic momentum (marginal change in compute demand, order/shipment
read-through, market-cap positioning), and price momentum (trend, moving
averages, momentum and crowding).

Decision weights: valuation ~40%, thematic momentum ~30%, price momentum and
timing ~30%. Strength in any single dimension can justify a buy; a high-PE name
with strong earnings growth and thematic momentum breaking out cleanly is
buyable; a low-PEG name with weakening theme/momentum need not be bought. Sell
when: PEG deteriorates materially, the theme reverses, or price breaks key
moving averages on shrinking volume.

Output STRICT JSON: {"signals":[{"symbol":"...","action":"buy|hold|sell","confidence":0..1,"size":0..1,"rationale":"English, <=80 chars"}]}
Do not output any other text.`;

/** Score a batch of symbols in ONE DeepSeek call (token-efficient). */
export async function scoreSymbols(
  snapshots: SymbolSnapshot[],
  opts: { asOf?: string; bypassCache?: boolean; mode?: "live" | "backtest" } = {},
): Promise<Signal[]> {
  if (snapshots.length === 0) return [];
  const userPayload = {
    as_of: opts.asOf ?? new Date().toISOString().slice(0, 10),
    scoring_rule: "40/30/30 balance: valuation (PEG = pe_ttm / profit_yoy_pct, lower is better) 40%, thematic momentum 30%, price momentum 30%. Strength in any single dimension can trigger a buy.",
    symbols: snapshots.map((s) => ({
      symbol: s.symbol,
      name: s.name ?? undefined,
      theme: s.theme,
      // truncate to last 30 closes to keep prompt small while preserving trend
      closes_tail30: s.closes.slice(-30).map((x) => Number(x.toFixed(3))),
      pe_ttm: s.fundamental?.pe_ttm ?? null,
      pb: s.fundamental?.pb ?? null,
      market_cap_b: s.fundamental?.market_cap ?? null,
      profit_yoy_pct: s.fundamental?.profit_yoy ?? null,
      peg: calcPeg(s.fundamental?.pe_ttm, s.fundamental?.profit_yoy),
    })),
  };

  const raw = await chat(
    [
      { role: "system", content: STRATEGY_SYSTEM },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
    {
      model: opts.mode === "backtest" ? BACKTEST_MODEL : MODEL,
      responseFormat: "json_object",
      temperature: 0.2,
      bypassCache: opts.bypassCache,
    },
  );

  try {
    const parsed = JSON.parse(raw) as { signals?: Signal[] };
    return parsed.signals ?? [];
  } catch {
    return [];
  }
}
