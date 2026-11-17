# OMW-detailed (Open Market Weather)

[![Market Weather](badge.svg)](https://omw.hartmut-nese.workers.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

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

## Why a Weather Report Instead of Charts?

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
|----------|----------|----------|----------|
| Market Volatility | 20% | VIX and MOVE | Yahoo Finance |
| Crypto Leverage | 20% | BTC perp funding and implied volatility (DVOL) | Hyperliquid, Deribit |
| Short Volume | 15% | Short volume share in SPY | FINRA Reg SHO |
| Dollar Liquidity | 20% | Treasury 
