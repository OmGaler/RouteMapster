#!/usr/bin/env python3
"""
Build a route-level summary DataFrame from processed data.

Sources:
- data/processed/garages.geojson (garage/operator + route allocations)
- data/processed/frequencies.json (buses per hour by band)
- data/processed/routes/*.geojson (route geometry for length)

Output:
- Optional CSV/JSON if --out is provided (format via extension).
"""

from __future__ import annotations

import argparse
from pathlib import Path

try:
    from scripts.utils.route_summary import build_route_summary_df
except ModuleNotFoundError:  # pragma: no cover - script execution fallback
    from utils.route_summary import build_route_summary_df


def main() -> int:
    parser = argparse.ArgumentParser(description="Build route summary table.")
    parser.add_argument("--garages", default="data/processed/garages.geojson", help="Garages GeoJSON.")
    parser.add_argument("--frequencies", default="data/processed/frequencies.json", help="Frequencies JSON.")
    parser.add_argument("--routes-dir", default="data/processed/routes", help="Route geometries directory.")
    parser.add_argument("--routes-index", default="data/processed/routes/index.json", help="Routes index JSON.")
    parser.add_argument("--out", default="", help="Optional output CSV/JSON path.")
    parser.add_argument("--include-excluded", action="store_true", help="Include excluded/700-series routes.")
    parser.add_argument("--skip-length", action="store_true", help="Skip route length calculation.")
    args = parser.parse_args()

    df = build_route_summary_df(
        garages_path=args.garages,
        frequencies_path=args.frequencies,
        routes_dir=args.routes_dir,
        routes_index_path=args.routes_index,
        include_excluded=args.include_excluded,
        include_length=not args.skip_length,
    )

    if not args.out:
        print(f"Built route summary DataFrame with {len(df)} rows.")
        return 0

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.suffix.lower() == ".json":
        df.to_json(out_path, orient="records")
    else:
        df.to_csv(out_path, index=False)

    print(f"Wrote {len(df)} routes to {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
