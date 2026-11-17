# OMW-detailed (Open Market Weather)

OMW is a market-weather dashboard built from public macro, liquidity, credit and crypto data.

Instead of trying to predict prices, it looks at the environment markets operate in and reduces it to a single weather-style score between 0 and 100. The idea is simple: before running a strategy, check whether the background conditions look calm, unstable or outright hostile.

The repository also includes a dependency-free Cloudflare Worker that calculates a structural fragility score for individual stocks.

Originally this started as a risk filter for a Hyperliquid grid bot. Before the bot keeps buying dips, it checks liquidity, volatility and leverage conditions to avoid accumulating into obviously stressed markets.

The scoring model is entirely heuristic. The weights, thresholds and normalization curves are hand-picked and have not been statistically calibrated or backtested.

**This is not a trading signal.**

## Live Endpoints

- Dashboard: `https://omw.hartmut-nese.workers.dev`
- Macro JSON: `https://omw.hartmut-nese.workers.dev/weather.json`
- Plain text: `https://omw.hartmut-nese.workers.dev/weather.txt`
- Stock Fragility API: `https://omw.hartmut-nese.workers.dev/api/fragility?symbol=SPCX&offer=135`

[![Market Weather](https://omw.hartmut-nese.workers.dev/badge.svg)](https://omw.hartmut-nese.workers.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)


---

## Status

- Runtime: Python 3.8+
- Dependencies: None (standard library only)
- Update frequency: Every 17 minutes
- Deployment: GitHub Actions + Cloudflare Workers
- Public API: Yes

---

## Architecture

```text
Yahoo Finance
FINRA
SEC EDGAR
US Treasury
New York Fed
Hyperliquid
Deribit
Wikimedia
CBP
       │
       ▼
   engine.py
       │
       ├── weather.json
       ├── weather.txt
       ├── index.html
       ├── badge.svg
       └── history.csv
       │
       ▼
Cloudflare Worker
(worker.js)
       │
       ▼
Dashboard + APIs
```

---

## Why a weather report instead of charts?

Most technical indicators only describe what price has already done.

Sometimes stress appears elsewhere first: volatility jumps, funding becomes extreme, credit events increase, liquidity starts moving around the system. A grid bot only sees a dip and may happily keep buying.

I'm not trying to predict prices. It's closer to checking the weather before leaving the house. If conditions are calm, business continues as usual. If a storm is building, it may be worth being more careful.

---

## Market Weather vs Tactical Posture

The weather score and the tactical posture are intentionally separate.

The weather score describes market conditions.

The tactical posture describes how a strategy reacts to those conditions using confirmation rules, hysteresis and feed-quality checks.

Because of that, a market can show:

```text
CLEAR SKIES
```

while a grid strategy remains:

```text
CAUTION
```

until conditions have been stable long enough.

---

## What Goes Into the Macro Score

| Pillar | Weight | What it Measures | Source |
|---------|---------|---------|---------|
| Market Volatility | 20% | VIX and MOVE | Yahoo Finance |
| Crypto Leverage | 20% | BTC perp funding and implied volatility (DVOL) | Hyperliquid, Deribit |
| Short Volume | 15% | Short volume share in SPY | FINRA Reg SHO |
| Dollar Liquidity | 20% | Treasury General Account and Fed FX swap usage | US Fiscal Data, NY Fed |
| Credit Stress | 15% | 8-K filings mentioning Item 2.04 | SEC EDGAR |
| Odds and Ends | 10% | Wikipedia crisis traffic and border wait times | Wikimedia, CBP |

Each pillar is normalized to a score between 0 and 100 and then combined using the weights above.

Weather classification:

| Score | Weather |
|---------|---------|
| 0–24 | ☀️ Clear Skies |
| 25–49 | ⛅ Scattered Clouds |
| 50–74 | 🌧 Rain |
| 75–100 | ⛈ Storm |

Example:

```json
{
  "composite_score": 24,
  "status": "CLEAR SKIES"
}
```

The FINRA daily file is around 15 MB, so it is streamed line-by-line rather than loaded into memory.

---

## Weather Output

The main API endpoint is:

```text
GET /weather.json
```

Example:

```json
{
  "composite_score": 24,
  "status": "CLEAR SKIES",
  "data_quality": {
    "status": "HIGH"
  },
  "tactical_posture": {
    "grid_bots": {
      "status": "CAUTION"
    }
  }
}
```

Important fields:

| Field | Description |
|---------|---------|
| `composite_score` | Rounded market weather score |
| `composite_raw` | Score with decimals |
| `status` | Weather classification |
| `data_quality` | Feed-health summary |
| `transition` | State-machine information |
| `tactical_posture` | Strategy-oriented guidance |

---

## Single-Stock Fragility Check

The repository includes a dependency-free Cloudflare Worker:

```text
GET /api/fragility?symbol=SPCX&offer=135
```

The Worker calculates a structural fragility score between 0 and 100.

Classification:

| Score | Label |
|---------|---------|
| 0–29 | stable |
| 30–54 | elevated |
| 55–100 | fragile |

Example:

```json
{
  "score": 61,
  "label": "fragile",
  "regime": "Overextended to the upside",
  "quality": "high"
}
```

### Factors

| Factor | Weight | What it Measures |
|---------|---------|---------|
| Volatility | 25% | Realized volatility and change versus baseline |
| Upside Extension | 15% | Distance above moving averages |
| Peak Drawdown | 15% | Distance below recent highs |
| Overnight Gaps | 10% | Average gap risk |
| Volume Spike | 10% | Recent volume versus baseline |
| Liquidity | 10% | Daily turnover |
| History Depth | 15% | Available price history |
| Offer Price Distance | 15% | Optional IPO/reference price comparison |

### Additional Behaviour

- Falls back to intraday data for very recent IPOs.
- Supports international Yahoo Finance ticker suffixes (`RHM.DE`, `VOD.L`, etc.).
- Uses Stooq daily data as a fallback.
- Results are cached at the Cloudflare edge for five minutes.
- Supports an optional IPO or reference price through `offer=`.

The Worker does not attempt to forecast direction. A high score does not mean a stock will go down, only that the price structure appears unstable.

---

## Reliability Features

The system tracks the health of every data source individually.

Feeds can be:

```text
OK
FALLBACK
STALE
CLOSED
```

Examples:

- Yahoo quotes older than five days become stale.
- FINRA files older than four days become stale.
- Treasury data older than six days becomes stale.
- CBP may report `CLOSED` when no official data is available overnight.

Each run produces:

- feed-health information
- data-quality metrics
- fallback indicators
- stale-data indicators
- runtime statistics

The weather report continues operating when a feed fails by falling back to predefined neutral values. A failed feed never causes an overly optimistic market status.

---

## Data Quality

`data_quality` summarizes feed health:

```json
{
  "status": "HIGH",
  "score": 100,
  "fallback_count": 0,
  "stale_count": 0
}
```

Classification:

| Score | Status |
|---------|---------|
| 90–100 | HIGH |
| 70–89 | MEDIUM |
| 0–69 | LOW |

If any feed runs on fallback or stale data:

```json
"run_status": "DEGRADED"
```

A degraded run can prevent tactical posture from returning immediately to its most aggressive state.

---

## Running Locally

### Requirements

- Python 3.8+
- Internet access
- No external packages

### Start

```bash
git clone https://github.com/hartmutnese-stack/OMW-detailed.git
cd OMW-detailed
python3 engine.py
```

The script generates:

```text
index.html
weather.json
weather.txt
badge.svg
history.csv
```

Files are written atomically using a temporary-file-and-rename pattern. If a run fails unexpectedly, the previous outputs remain untouched.

---

## Deployment

The reference deployment runs on:

- GitHub Actions
- Cloudflare Workers
- Cloudflare Static Assets

The macro-weather outputs can be served from any static host.

The stock fragility endpoint requires the Cloudflare Worker because browsers cannot call the upstream data sources directly due to CORS restrictions.

---

## Environment Variables

| Variable | Description |
|---------|---------|
| `OMW_CONTACT` | Contact string for SEC and Wikimedia requests |
| `OMW_BASE_URL` | Public deployment URL |
| `OMW_REPO_URL` | Repository URL shown in outputs |
| `OMW_VALID_FOR_HOURS` | Output validity window |
| `OMW_STATE_MAX_AGE_HOURS` | Maximum age of previous state |
| `OMW_RECOVERY_CONFIRMATIONS` | Confirmation count for state transitions |
| `OMW_COLD_START_STATUS` | Initial state when no previous state exists |

---

## Using It in a Bot

`weather.json` contains a `tactical_posture` block intended as a machine-readable reference layer.

Example:

```json
{
  "tactical_posture": {
    "grid_bots": {
      "status": "CAUTION"
    }
  }
}
```

The default grid posture works roughly like this:

- `ACTIVE` when conditions are calm and all feeds are healthy
- `CAUTION` for transitional situations
- `PAUSED` during elevated stress

The underlying logic includes:

- hysteresis
- confirmation rules
- feed-quality safeguards
- recovery confirmation counts

The protocol is intentionally conservative. It takes longer to leave a cautious state than to enter one.

---

## Things to Know Before You Trust It

- All thresholds are heuristic.
- No historical calibration has been performed yet.
- Short-volume data is noisy.
- Treasury flows can indicate either liquidity injection or liquidity withdrawal.
- Wikipedia traffic is experimental.
- Crypto, Treasury and FINRA data operate on different schedules.
- Several data sources rely on unofficial or undocumented endpoints.
- Public APIs can change or disappear without notice.

The project records raw values in `history.csv` to support future calibration work.

---

## Disclaimer

This is a hobby project that aggregates public data.

Nothing in this repository is investment advice, a trading signal, or a recommendation to buy, sell or hold any asset.

The underlying data can be delayed, incomplete or wrong. Use it at your own risk.

---

## Contributing

If you have ideas for:

- better normalization curves
- more robust feeds
- historical calibration
- additional market indicators

feel free to open an issue or submit a pull request.

---

## License

MIT
