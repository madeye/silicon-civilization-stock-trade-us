"""FastAPI sidecar wrapping Yahoo Finance (+ fallbacks) for US equities.

Data-source split (US market):
- Primary: yfinance (no token/quota) for daily klines, fundamentals
  (PE/PB/market-cap/growth), realtime-ish spot quotes, and sell-side analyst
  consensus (recommendation counts + mean price target).
- Fallback klines: Stooq daily CSV (no token) when Yahoo is unreachable.
- Optional: Finnhub (FINNHUB_API_KEY) for realtime quotes and Alpha Vantage
  (ALPHAVANTAGE_API_KEY) as an extra fundamentals/quote fallback. Both are
  disabled unless their API key is present, so the server runs key-free.

All responses write through a SQLite cache so upstream is hit at most once per
symbol per trading day (klines/fundamentals/analyst) or per 30s (spot).
"""
from __future__ import annotations

import csv
import io
import json
import os
import sqlite3
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd
import requests
import yfinance as yf
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel

# ---------- bootstrap ------------------------------------------------------

load_dotenv(Path(__file__).parent / ".env")

# Optional API keys — providers stay disabled unless the matching key is set.
FINNHUB_API_KEY = os.environ.get("FINNHUB_API_KEY") or None
ALPHAVANTAGE_API_KEY = os.environ.get("ALPHAVANTAGE_API_KEY") or None

DB_PATH = Path(__file__).parent / "cache.db"
NY_TZ = ZoneInfo("America/New_York")

app = FastAPI(title="silicon-civ pyserver (US)", version="1.0.0")

# ---------- cache ----------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  ttl_seconds INTEGER NOT NULL
);
"""


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(SCHEMA)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def cache_get(key: str) -> Any | None:
    with db() as conn:
        row = conn.execute(
            "SELECT payload, fetched_at, ttl_seconds FROM cache WHERE key = ?",
            (key,),
        ).fetchone()
    if not row:
        return None
    payload, fetched_at, ttl = row
    if ttl > 0 and time.time() - fetched_at > ttl:
        return None
    return json.loads(payload)


def cache_put(key: str, value: Any, ttl_seconds: int) -> None:
    with db() as conn:
        conn.execute(
            "REPLACE INTO cache (key, payload, fetched_at, ttl_seconds) VALUES (?, ?, ?, ?)",
            (key, json.dumps(value, ensure_ascii=False), int(time.time()), ttl_seconds),
        )


def seconds_until_next_trading_close() -> int:
    """TTL so daily klines refresh after the next 16:00 US/Eastern close."""
    now = datetime.now(NY_TZ)
    target = now.replace(hour=16, minute=0, second=0, microsecond=0)
    if now >= target:
        target += timedelta(days=1)
    return int((target - now).total_seconds())


# ---------- retry wrapper + per-endpoint rate limiter ----------------------


class _TokenBucket:
    """Simple token bucket — at most `n` calls per `window_s` seconds."""

    def __init__(self, n: int, window_s: float) -> None:
        self.n = n
        self.window = window_s
        self.calls: deque[float] = deque()
        self.lock = threading.Lock()

    def acquire(self) -> None:
        while True:
            with self.lock:
                now = time.monotonic()
                while self.calls and now - self.calls[0] > self.window:
                    self.calls.popleft()
                if len(self.calls) < self.n:
                    self.calls.append(now)
                    return
                wait = self.window - (now - self.calls[0]) + 0.05
            time.sleep(wait)


# Yahoo tolerates bursts but throttles aggressive scraping; keep a soft cap so a
# whole-watchlist refresh does not trip rate limits.
_YF_LIMITER = _TokenBucket(n=20, window_s=2)
_SPOT_BATCH_CONCURRENCY = 8


def _with_retries(fn, *args, attempts: int = 3, base_delay: float = 0.5, **kwargs):
    last: Exception | None = None
    for i in range(attempts):
        try:
            return fn(*args, **kwargs)
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(base_delay * (2 ** i))
    assert last is not None
    raise last


# ---------- models ---------------------------------------------------------


class Kline(BaseModel):
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: float


class Fundamental(BaseModel):
    symbol: str
    name: str | None = None
    pe_ttm: float | None = None
    pb: float | None = None
    market_cap: float | None = None  # billions USD
    revenue_yoy: float | None = None
    profit_yoy: float | None = None


class Analyst(BaseModel):
    symbol: str
    buy_count: int | None = None
    total_count: int | None = None
    buy_ratio: float | None = None
    consensus_eps_next: float | None = None
    implied_target: float | None = None
    current_price: float | None = None
    upside_pct: float | None = None


# ---------- symbol normalization -------------------------------------------


def _norm_symbol(symbol: str) -> str:
    """Normalize an input ticker to the Yahoo Finance convention.

    US class shares use a dash on Yahoo (e.g. BRK.B -> BRK-B). Accepts an
    optional leading "$" and is case-insensitive.
    """
    s = symbol.strip().upper().lstrip("$")
    return s.replace(".", "-")


def _stooq_symbol(symbol: str) -> str:
    """Stooq uses lowercase ticker + `.us`, with dots stripped from classes."""
    return _norm_symbol(symbol).replace("-", ".").lower() + ".us"


def _num_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _market_cap_to_billions(value: float | None) -> float | None:
    if value is None:
        return None
    # Yahoo reports market cap in raw USD; expose billions for compact display.
    return value / 1e9 if abs(value) > 1e6 else value


# ---------- yfinance helpers ----------------------------------------------

# yfinance Ticker objects cache .info per instance; keep one per symbol process-
# wide so repeated endpoints within a render reuse a single upstream fetch.
_TICKERS: dict[str, yf.Ticker] = {}
_TICKER_LOCK = threading.Lock()


def _ticker(symbol: str) -> yf.Ticker:
    sym = _norm_symbol(symbol)
    with _TICKER_LOCK:
        t = _TICKERS.get(sym)
        if t is None:
            t = yf.Ticker(sym)
            _TICKERS[sym] = t
    return t


def _yf_history(symbol: str, start: str, end: str, adjusted: bool) -> list[dict[str, Any]] | None:
    """Daily klines via yfinance, filtered to [start, end] (YYYY-MM-DD)."""
    _YF_LIMITER.acquire()
    try:
        df = _ticker(symbol).history(
            start=start, end=end, interval="1d",
            auto_adjust=adjusted, actions=False, raise_errors=False,
        )
    except Exception:
        return None
    if df is None or df.empty:
        return None
    rows: list[dict[str, Any]] = []
    for idx, r in df.iterrows():
        d = pd.Timestamp(idx).strftime("%Y-%m-%d")
        close = _num_or_none(r.get("Close"))
        if close is None:
            continue
        rows.append({
            "date": d,
            "open": float(_num_or_none(r.get("Open")) or close),
            "high": float(_num_or_none(r.get("High")) or close),
            "low": float(_num_or_none(r.get("Low")) or close),
            "close": float(close),
            "volume": float(_num_or_none(r.get("Volume")) or 0),
        })
    return rows or None


def _stooq_history(symbol: str, start: str, end: str) -> list[dict[str, Any]] | None:
    """Fallback daily klines via Stooq CSV (split/dividend adjusted, no key)."""
    url = "https://stooq.com/q/d/l/"
    params = {
        "s": _stooq_symbol(symbol),
        "d1": start.replace("-", ""),
        "d2": end.replace("-", ""),
        "i": "d",
    }
    try:
        resp = requests.get(url, params=params, timeout=8)
        resp.raise_for_status()
    except Exception:
        return None
    text = resp.text.strip()
    if not text or text.lower().startswith("no data") or "," not in text:
        return None
    rows: list[dict[str, Any]] = []
    for row in csv.DictReader(io.StringIO(text)):
        d = row.get("Date")
        close = _num_or_none(row.get("Close"))
        if not d or close is None:
            continue
        rows.append({
            "date": d,
            "open": float(_num_or_none(row.get("Open")) or close),
            "high": float(_num_or_none(row.get("High")) or close),
            "low": float(_num_or_none(row.get("Low")) or close),
            "close": float(close),
            "volume": float(_num_or_none(row.get("Volume")) or 0),
        })
    return rows or None


def _yf_fast_quote(symbol: str) -> dict[str, Any] | None:
    """Realtime-ish quote from yfinance fast_info (no heavy .info fetch)."""
    _YF_LIMITER.acquire()
    try:
        fi = _ticker(symbol).fast_info
        price = _num_or_none(fi.get("last_price") if hasattr(fi, "get") else fi.last_price)
        prev = _num_or_none(fi.get("previous_close") if hasattr(fi, "get") else fi.previous_close)
        volume = _num_or_none(fi.get("last_volume") if hasattr(fi, "get") else getattr(fi, "last_volume", None))
    except Exception:
        return None
    if price is None or price <= 0:
        return None
    change_pct = round((price / prev - 1) * 100, 2) if prev and prev > 0 else 0
    return {
        "symbol": symbol,
        "name": _resolve_name(symbol) or symbol,
        "price": round(price, 4),
        "change_pct": change_pct,
        "volume": volume or 0,
        "turnover": round((volume or 0) * price, 2),
    }


def _finnhub_quote(symbol: str) -> dict[str, Any] | None:
    """Optional realtime quote via Finnhub (requires FINNHUB_API_KEY)."""
    if not FINNHUB_API_KEY:
        return None
    try:
        resp = requests.get(
            "https://finnhub.io/api/v1/quote",
            params={"symbol": _norm_symbol(symbol), "token": FINNHUB_API_KEY},
            timeout=5,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return None
    price = _num_or_none(data.get("c"))
    if price is None or price <= 0:
        return None
    return {
        "symbol": symbol,
        "name": _resolve_name(symbol) or symbol,
        "price": round(price, 4),
        "change_pct": round(_num_or_none(data.get("dp")) or 0, 2),
        "volume": 0,
        "turnover": 0,
    }


# Cache the long-name lookups once per process so spot/fundamental reuse them.
_NAME_CACHE: dict[str, str] = {}


def _resolve_name(symbol: str) -> str | None:
    sym = _norm_symbol(symbol)
    if sym in _NAME_CACHE:
        return _NAME_CACHE[sym]
    try:
        fi = _ticker(sym).fast_info
        # fast_info has no name; fall back to .info lazily and cheaply guard it.
        name = None
        try:
            info = _ticker(sym).info
            name = info.get("shortName") or info.get("longName")
        except Exception:
            name = None
        _ = fi  # touch fast_info to ensure the ticker is reachable
    except Exception:
        return None
    if name:
        _NAME_CACHE[sym] = str(name)
    return _NAME_CACHE.get(sym)


def _yf_info(symbol: str) -> dict[str, Any]:
    _YF_LIMITER.acquire()
    try:
        return dict(_ticker(symbol).info or {})
    except Exception:
        return {}


# ---------- endpoints ------------------------------------------------------


@app.get("/health")
def health():
    return {"ok": True, "time": datetime.now().isoformat(), "source": "yfinance"}


@app.get("/klines", response_model=list[Kline])
def klines(
    symbol: str = Query(..., description="US ticker, e.g. NVDA, AAPL, BRK.B"),
    start: str = Query("2023-01-01"),
    end: str | None = Query(None),
    adjust: str = Query("adj", description="adj = split/div adjusted, raw = unadjusted"),
):
    end = end or date.today().strftime("%Y-%m-%d")
    # Accept both YYYYMMDD and YYYY-MM-DD on input; emit ISO dates downstream.
    start_iso = _to_iso(start)
    end_iso = _to_iso(end)
    adjusted = adjust not in {"", "raw", "none"}
    key = f"kline:us:{_norm_symbol(symbol)}:{start_iso}:{end_iso}:{int(adjusted)}"
    cached = cache_get(key)
    if cached is not None:
        return cached

    # yfinance `end` is exclusive — push it one day forward to include `end`.
    yf_end = (datetime.strptime(end_iso, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    rows = _with_retries(_yf_history, symbol, start_iso, yf_end, adjusted, attempts=2)
    if not rows:
        rows = _stooq_history(symbol, start_iso, end_iso)
    if not rows:
        cache_put(key, [], 3600)
        return []
    rows = [r for r in rows if start_iso <= r["date"] <= end_iso]
    cache_put(key, rows, seconds_until_next_trading_close())
    return rows


@app.get("/fundamental", response_model=Fundamental)
def fundamental(symbol: str):
    key = f"fund:us:{_norm_symbol(symbol)}"
    cached = cache_get(key)
    if cached is not None:
        return cached

    out: dict[str, Any] = {"symbol": symbol}
    info = _yf_info(symbol)
    if info:
        out["name"] = info.get("shortName") or info.get("longName")
        out["pe_ttm"] = _num_or_none(info.get("trailingPE"))
        out["pb"] = _num_or_none(info.get("priceToBook"))
        out["market_cap"] = _market_cap_to_billions(_num_or_none(info.get("marketCap")))
        rev = _num_or_none(info.get("revenueGrowth"))
        prof = _num_or_none(info.get("earningsGrowth")) or _num_or_none(info.get("earningsQuarterlyGrowth"))
        out["revenue_yoy"] = round(rev * 100, 2) if rev is not None else None
        out["profit_yoy"] = round(prof * 100, 2) if prof is not None else None
        if out.get("name"):
            _NAME_CACHE[_norm_symbol(symbol)] = str(out["name"])

    cache_put(key, out, 24 * 3600)
    return out


@app.get("/analyst", response_model=Analyst)
def analyst(symbol: str):
    """Sell-side consensus from Yahoo Finance.

    buy_count/total_count come from the latest recommendation-trend row;
    implied_target is the mean analyst price target; consensus_eps_next is the
    forward EPS estimate.
    """
    key = f"analyst:us:{_norm_symbol(symbol)}"
    cached = cache_get(key)
    if cached is not None:
        return cached

    out: dict[str, Any] = {"symbol": symbol}
    info = _yf_info(symbol)

    # Current price + mean target.
    price = _num_or_none(info.get("currentPrice")) or _num_or_none(info.get("regularMarketPrice"))
    if price is None:
        quote = _yf_fast_quote(symbol)
        price = _num_or_none(quote.get("price")) if quote else None
    if price is not None:
        out["current_price"] = round(price, 4)

    target = _num_or_none(info.get("targetMeanPrice"))
    if target is not None and target > 0:
        out["implied_target"] = round(target, 4)
        if out.get("current_price"):
            out["upside_pct"] = round((target / out["current_price"] - 1) * 100, 2)

    out["consensus_eps_next"] = _num_or_none(info.get("forwardEps"))

    total = _num_or_none(info.get("numberOfAnalystOpinions"))
    if total is not None:
        out["total_count"] = int(total)

    # Recommendation breakdown — prefer the structured trend table.
    try:
        rec = _ticker(symbol).recommendations
    except Exception:
        rec = None
    if rec is not None and not rec.empty:
        row = rec.iloc[0]
        strong_buy = int(_num_or_none(row.get("strongBuy")) or 0)
        buy = int(_num_or_none(row.get("buy")) or 0)
        hold = int(_num_or_none(row.get("hold")) or 0)
        sell = int(_num_or_none(row.get("sell")) or 0)
        strong_sell = int(_num_or_none(row.get("strongSell")) or 0)
        total_rec = strong_buy + buy + hold + sell + strong_sell
        if total_rec > 0:
            out["buy_count"] = strong_buy + buy
            out["total_count"] = total_rec
            out["buy_ratio"] = round(out["buy_count"] / total_rec, 3)

    cache_put(key, out, 24 * 3600)
    return out


@app.get("/analysts", response_model=list[Analyst])
def analysts(symbols: str = Query(..., description="comma-separated symbols")):
    uniq = []
    seen: set[str] = set()
    for raw in symbols.split(","):
        s = raw.strip()
        if s and s not in seen:
            seen.add(s)
            uniq.append(s)
    out: list[dict[str, Any]] = []
    for symbol in uniq:
        try:
            out.append(analyst(symbol))
        except Exception:
            out.append({"symbol": symbol})
    return out


@app.get("/spot")
def spot(symbol: str):
    """Latest quote. yfinance fast_info first, Finnhub/last-close as fallback."""
    key = f"spot:us:{_norm_symbol(symbol)}"
    cached = cache_get(key)
    if cached is not None:
        return cached

    out = _yf_fast_quote(symbol) or _finnhub_quote(symbol)
    if out is None:
        # Fall back to the most recent daily close.
        end = date.today().strftime("%Y-%m-%d")
        start = (date.today() - timedelta(days=10)).strftime("%Y-%m-%d")
        rows = _yf_history(symbol, start, end, adjusted=True) or _stooq_history(symbol, start, end)
        if not rows:
            raise HTTPException(404, f"symbol {symbol} not found")
        last = rows[-1]
        prev_close = rows[-2]["close"] if len(rows) >= 2 else last["close"]
        change_pct = round((last["close"] / prev_close - 1) * 100, 2) if prev_close else 0
        out = {
            "symbol": symbol,
            "name": _resolve_name(symbol) or symbol,
            "price": last["close"],
            "change_pct": change_pct,
            "volume": last["volume"],
            "turnover": round(last["close"] * last["volume"], 2),
        }
    cache_put(key, out, 30)
    return out


@app.get("/spots")
def spots(symbols: str = Query(..., description="comma-separated symbols")):
    """Batch spot quotes for the frontend table.

    Caching stays authoritative in pyserver while avoiding the Next.js layer
    fanning one browser batch out into dozens of HTTP requests.
    """
    uniq: list[str] = []
    seen: set[str] = set()
    for raw in symbols.split(","):
        symbol = raw.strip()
        if not symbol or symbol in seen:
            continue
        seen.add(symbol)
        uniq.append(symbol)

    out: list[dict[str, Any]] = []
    missing: list[str] = []
    for symbol in uniq:
        cached = cache_get(f"spot:us:{_norm_symbol(symbol)}")
        if cached is not None:
            out.append(cached)
        else:
            missing.append(symbol)

    if missing:
        with ThreadPoolExecutor(max_workers=min(_SPOT_BATCH_CONCURRENCY, len(missing))) as executor:
            futures = {executor.submit(spot, symbol): symbol for symbol in missing}
            for future in as_completed(futures):
                try:
                    out.append(future.result())
                except Exception:
                    continue

    by_symbol = {str(row.get("symbol")): row for row in out}
    return [by_symbol[symbol] for symbol in uniq if symbol in by_symbol]


# ---------- date helpers ---------------------------------------------------


def _to_iso(s: str) -> str:
    """Accept YYYYMMDD or YYYY-MM-DD; return YYYY-MM-DD."""
    s = s.strip()
    if "-" in s:
        return s
    if len(s) == 8 and s.isdigit():
        return f"{s[:4]}-{s[4:6]}-{s[6:]}"
    return s
