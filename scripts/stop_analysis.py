#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

try:
    from scripts.stop_analysis.centrality import (
        build_output_rows,
        compute_metrics_on_lcc,
        print_sanity_report,
        write_metrics_csv,
    )
    from scripts.stop_analysis.graph import build_stop_graph, print_graph_summary
except ModuleNotFoundError:  # pragma: no cover - script execution fallback
    from stop_analysis.centrality import (
        build_output_rows,
        compute_metrics_on_lcc,
        print_sanity_report,
        write_metrics_csv,
    )
    from stop_analysis.graph import build_stop_graph, print_graph_summary


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser(description="Stop-level topological graph + metrics.")
    sub = parser.add_subparsers(dest="command", required=True)

    build = sub.add_parser("build-graph", help="Build the stop-level graph and print summary.")
    build.add_argument("--stops", default=str(repo_root() / "data" / "processed" / "stops.geojson"))
    build.add_argument(
        "--sequences",
        default=str(repo_root() / "data" / "processed" / "stop_analysis" / "route_sequences.jsonl"),
    )

    metrics = sub.add_parser("metrics", help="Compute stop-level metrics and export CSV.")
    metrics.add_argument("--stops", default=str(repo_root() / "data" / "processed" / "stops.geojson"))
    metrics.add_argument(
        "--sequences",
        default=str(repo_root() / "data" / "processed" / "stop_analysis" / "route_sequences.jsonl"),
    )
    metrics.add_argument(
        "--output",
        default=str(repo_root() / "data" / "processed" / "stop_analysis" / "stop_metrics.csv"),
    )
    centrality = sub.add_parser("centrality", help="Alias for metrics (legacy).")
    centrality.add_argument("--stops", default=str(repo_root() / "data" / "processed" / "stops.geojson"))
    centrality.add_argument(
        "--sequences",
        default=str(repo_root() / "data" / "processed" / "stop_analysis" / "route_sequences.jsonl"),
    )
    centrality.add_argument(
        "--output",
        default=str(repo_root() / "data" / "processed" / "stop_analysis" / "stop_metrics.csv"),
    )

    args = parser.parse_args()

    if args.command == "build-graph":
        graph, _stop_index, stats = build_stop_graph(Path(args.stops), Path(args.sequences))
        print_graph_summary(stats)
        return 0

    if args.command in {"metrics", "centrality"}:
        graph, _stop_index, stats = build_stop_graph(Path(args.stops), Path(args.sequences))
        print_graph_summary(stats)
        lcc, metrics_out = compute_metrics_on_lcc(graph)
        print_sanity_report(graph, lcc, metrics_out)
        rows = build_output_rows(graph, lcc, metrics_out)
        write_metrics_csv(Path(args.output), rows)
        print(f"Wrote metrics to {args.output}")
        return 0

    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
