#!/usr/bin/env python3
"""
Build a route-level summary DataFrame from processed data.

Sources:
- data/processed/garages.geojson (garage/operator + route allocations)
- data/processed/frequencies.json (buses per hour by band)
- data/processed/route_destinations.json (cached passenger-facing blind destinations)
- data/processed/routes/*.geojson (route geometry for length)

Output:
- CSV/JSON at --out path (format via extension, defaults to data/processed/route_summary.csv).
"""

from __future__ import annotations

import argparse
from pathlib import Path

try:
    from scripts.utils.route_summary import build_route_summary_df
except ModuleNotFoundError:  # pragma: no cover - script execution fallback
    from utils.route_summary import build_route_summary_df


def main() -> int:
    """Build the route summary dataset from processed pipeline inputs.

    Returns:
        Process exit code for CLI usage.

    Side effects:
        Reads processed datasets, writes CSV or JSON output, and prints a short
        completion message to stdout.
    """
    parser = argparse.ArgumentParser(description="Build route summary table.")
    parser.add_argument("--garages", default="data/processed/garages.geojson", help="Garages GeoJSON.")
    parser.add_argument("--frequencies", default="data/processed/frequencies.json", help="Frequencies JSON.")
    parser.add_argument("--destinations", default="data/processed/route_destinations.json", help="Cached route destinations JSON.")
    parser.add_argument("--routes-dir", default="data/processed/routes", help="Route geometries directory.")
    parser.add_argument("--routes-index", default="data/processed/routes/index.json", help="Routes index JSON.")
    parser.add_argument("--out", default="data/processed/route_summary.csv", help="Output CSV/JSON path.")
    parser.add_argument("--include-excluded", action="store_true", help="Include excluded/700-series routes.")
    parser.add_argument("--skip-length", action="store_true", help="Skip route length calculation.")
    args = parser.parse_args()

    df = build_route_summary_df(
        garages_path=args.garages,
        frequencies_path=args.frequencies,
        destinations_path=args.destinations,
        routes_dir=args.routes_dir,
        routes_index_path=args.routes_index,
        include_excluded=args.include_excluded,
        include_length=not args.skip_length,
    )

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
