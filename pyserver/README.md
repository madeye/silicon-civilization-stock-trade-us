# pyserver — Yahoo Finance sidecar (US equities)

A lightweight FastAPI sidecar that wraps [yfinance](https://github.com/ranaroussi/yfinance)
(Yahoo Finance) and a couple of fallback sources, exposing only the endpoints the
Next.js site needs.

Every response is written to `cache.db` (SQLite) with a layered TTL per endpoint:

| Endpoint | TTL | Data source |
|---|---|---|
| `GET /klines` | until the next 16:00 US/Eastern close | yfinance daily history; Stooq CSV fallback |
| `GET /fundamental` | 24h | yfinance `.info` (trailing PE, P/B, market cap, growth) |
| `GET /analyst` | 24h | yfinance recommendation trend + mean price target + forward EPS |
| `GET /analysts` | 24h | batch wrapper over `GET /analyst` |
| `GET /spot` | 30s | yfinance `fast_info`; Finnhub (if keyed) / last close fallback |
| `GET /spots` | 30s | batch wrapper over `GET /spot`, reading `cache.db` first |

## Keys (all optional)

The sidecar runs key-free: Yahoo Finance needs no token and Stooq is the automatic
klines fallback. Two optional providers light up only when their key is present in
`pyserver/.env` (gitignored):

```
# FINNHUB_API_KEY=...        # realtime quotes
# ALPHAVANTAGE_API_KEY=...   # extra fundamentals/quote fallback
```

`.env` is loaded automatically at startup via `python-dotenv`.

## Run

Dependencies are managed with [uv](https://docs.astral.sh/uv/) — `pyproject.toml`
is the manifest and `uv.lock` pins exact versions.

```bash
uv sync                                      # create .venv and install locked deps
uv run uvicorn main:app --port 8001 --reload
```

Add/upgrade deps:

```bash
uv add <pkg>           # writes pyproject.toml + uv.lock
uv lock --upgrade      # bulk upgrade
```

## Why a sidecar?

yfinance and most US-market data libraries live in the Python ecosystem. Isolating
them in a standalone FastAPI process keeps the Next.js side pure TypeScript while
consuming a stable, typed, self-caching HTTP API. The sidecar also centralizes:

- Symbol normalization (`brk.b` ↔ `BRK-B`, optional leading `$`).
- Backoff retries (3 attempts, exponential) to absorb upstream jitter.
- A soft token-bucket rate limit so a whole-watchlist refresh does not trip Yahoo.
- A 30s spot-quote cache so prices/PE/market cap stop hitting upstream per symbol.
- A process-wide name cache.

## Endpoint cheatsheet

```bash
# health
curl http://localhost:8001/health

# daily klines (split/dividend adjusted)
curl 'http://localhost:8001/klines?symbol=NVDA&start=2024-01-01'

# fundamentals (PE/PB/market cap in $B, 24h cache)
curl 'http://localhost:8001/fundamental?symbol=AMD'

# sell-side consensus (24h cache)
curl 'http://localhost:8001/analyst?symbol=AMD'

# batch consensus — used by the watchlist table
curl 'http://localhost:8001/analysts?symbols=NVDA,AMD,AVGO'

# latest quote (30s cache)
curl 'http://localhost:8001/spot?symbol=NVDA'

# batch quotes — used by the watchlist table
curl 'http://localhost:8001/spots?symbols=NVDA,AMD,AVGO'
```

## Symbol rules

All endpoints accept the same ticker forms (case-insensitive, optional `$`):

| Input | Normalized (Yahoo) |
|---|---|
| `nvda`, `NVDA`, `$NVDA` | `NVDA` |
| `brk.b`, `BRK.B` | `BRK-B` |
