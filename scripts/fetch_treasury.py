"""Download Daily Treasury Par Yield Curve Rates from home.treasury.gov.

Saves Treasury's CSV for each calendar year, unmodified, to data/treasury/<year>.csv
and writes data/treasury/manifest.json listing the years and when they were fetched.
The site reads these files first because the Treasury endpoint can take ~20s to answer.

    python scripts/fetch_treasury.py              # every year, 1990 to today
    python scripts/fetch_treasury.py --recent     # current year (and last year in January)
    python scripts/fetch_treasury.py 2008 2020    # specific years
"""

import argparse
import csv
import datetime as dt
import io
import json
import pathlib
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

FIRST_YEAR = 1990
URL = (
    "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/"
    "daily-treasury-rates.csv/{year}/all?type=daily_treasury_yield_curve"
    "&field_tdr_date_value={year}&page&_format=csv"
)
OUT = pathlib.Path(__file__).resolve().parent.parent / "data" / "treasury"


def fetch(year: int, attempts: int = 4) -> str:
    req = urllib.request.Request(URL.format(year=year), headers={"User-Agent": "YieldTracker3000"})
    for i in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                text = r.read().decode("utf-8-sig")
            validate(year, text)
            return text
        except Exception as e:  # network errors and malformed responses both retry
            if i == attempts - 1:
                raise RuntimeError(f"{year}: {e}") from e
            time.sleep(5 * (i + 1))


def validate(year: int, text: str) -> None:
    rows = list(csv.reader(io.StringIO(text)))
    if not rows or rows[0][0] != "Date" or "10 Yr" not in rows[0]:
        raise ValueError("response is not a Treasury yield curve CSV")
    if len(rows) < 2 and year < dt.date.today().year:
        raise ValueError("no rows for a completed year")
    for r in rows[1:]:
        if not r[0].endswith(str(year)):
            raise ValueError(f"row dated {r[0]} in the {year} file")


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("years", nargs="*", type=int)
    p.add_argument("--recent", action="store_true")
    args = p.parse_args()

    today = dt.date.today()
    if args.years:
        years = args.years
    elif args.recent:
        years = [today.year] + ([today.year - 1] if today.month == 1 else [])
    else:
        years = list(range(FIRST_YEAR, today.year + 1))

    OUT.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        for year, text in zip(years, pool.map(fetch, years)):
            rows = text.count("\n") - 1
            if rows < 1:
                print(f"{year}: no data yet, skipped")
                continue
            (OUT / f"{year}.csv").write_text(text, encoding="utf-8", newline="")
            print(f"{year}: {rows} days")

    saved = sorted(int(f.stem) for f in OUT.glob("*.csv"))
    manifest = {
        "source": "U.S. Department of the Treasury, Daily Treasury Par Yield Curve Rates",
        "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "years": saved,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
