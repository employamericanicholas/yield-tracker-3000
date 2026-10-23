# Yield Tracker 3000

An Employ America site that charts the U.S. Treasury par yield curve for any trading day since January 2, 1990.

**Data:** U.S. Department of the Treasury, [Daily Treasury Par Yield Curve Rates](https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve).
See Treasury's [yield curve methodology](https://home.treasury.gov/policy-issues/financing-the-government/interest-rate-statistics/treasury-yield-curve-methodology).

## How it works

- `data/treasury/<year>.csv` are Treasury's own CSV files, unmodified, one per year.
  The page reads these first because `home.treasury.gov` can take about 20 seconds to respond.
- After the page loads, it fetches the current year live from treasury.gov
  and adds any days newer than the saved copy.
- `.github/workflows/refresh-data.yml` re-downloads the current year every weekday evening
  and commits it if anything changed.

## Features

- Year and date dropdowns, previous/next trading-day buttons (or the ← → keys), and a Latest button
- Optional comparison with the curve 1 week, 1 month, 1 year or 5 years earlier
- Maturities spaced evenly or drawn to scale
- 10-year yield, 10y–2y and 10y–3m spreads, with inversions flagged
- A table of every maturity, and links to the matching Treasury page and CSV
- Shareable links: the URL records the date, comparison and spacing, e.g. `#date=2008-10-21&compare=1y`

## Run locally

```sh
python -m http.server 8000
# open http://localhost:8000
```

## Refresh the data by hand

```sh
python scripts/fetch_treasury.py            # every year since 1990
python scripts/fetch_treasury.py --recent   # just the current year
```

## Brand

Colors and type follow the Employ America Brand Guidelines 2025 (the same tokens as the 50 States of Electricity site).
The two curve colors are brand Blue and Orange, adjusted in lightness to pass color-vision and contrast checks in light and dark mode.
