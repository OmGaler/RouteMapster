from __future__ import annotations

import csv
import statistics
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import networkx as nx

try:
    from scripts.stop_analysis.common import utc_now_iso
except ModuleNotFoundError:  # pragma: no cover - script execution fallback
    from stop_analysis.common import utc_now_iso


@dataclass
class MetricOutput:
    values: Dict[str, float]
    ranks: Dict[str, int]
    percentiles: Dict[str, int]


def _log(message: str) -> None:
    print(f"[{utc_now_iso()}] {message}")


def _dense_ranks(values: Dict[str, float]) -> Dict[str, int]:
    ordered = sorted(values.items(), key=lambda item: (-item[1], item[0]))
    ranks: Dict[str, int] = {}
    current_rank = 0
    last_value: Optional[float] = None
    for node_id, value in ordered:
        if last_value is None or value != last_value:
            current_rank += 1
            last_value = value
        ranks[node_id] = current_rank
    return ranks


def _percentiles(values: Dict[str, float]) -> Dict[str, int]:
    ordered = sorted(values.items(), key=lambda item: (-item[1], item[0]))
    total = len(ordered)
    if total == 0:
        return {}
    if total == 1:
        return {ordered[0][0]: 100}

    groups: Dict[float, List[int]] = {}
    for idx, (_node, value) in enumerate(ordered):
        groups.setdefault(value, []).append(idx)

    percentiles: Dict[str, int] = {}
    for value, indices in groups.items():
        avg_idx = sum(indices) / float(len(indices))
        pct = int(round(100.0 * (total - 1 - avg_idx) / float(total - 1)))
        pct = max(0, min(100, pct))
        for idx in indices:
            node_id = ordered[idx][0]
            percentiles[node_id] = pct
    return percentiles


def compute_metric_output(values: Dict[str, float]) -> MetricOutput:
    return MetricOutput(
        values=values,
        ranks=_dense_ranks(values),
        percentiles=_percentiles(values),
    )


def compute_metrics_on_lcc(graph: nx.Graph) -> Tuple[nx.Graph, Dict[str, MetricOutput]]:
    if graph.number_of_nodes() == 0:
        return graph.copy(), {}
    components = list(nx.connected_components(graph))
    if not components:
        return graph.copy(), {}
    lcc_nodes = max(components, key=len)
    lcc = graph.subgraph(lcc_nodes).copy()

    degree = {str(node): int(val) for node, val in lcc.degree()}
    betweenness = nx.betweenness_centrality(lcc, normalized=True)
    betweenness = {str(node): float(val) for node, val in betweenness.items()}
    closeness = nx.closeness_centrality(lcc)
    closeness = {str(node): float(val) for node, val in closeness.items()}

    metrics = {
        "degree": compute_metric_output(degree),
        "betweenness": compute_metric_output(betweenness),
        "closeness": compute_metric_output(closeness),
    }
    return lcc, metrics


def build_output_rows(
    graph: nx.Graph,
    lcc: nx.Graph,
    metrics: Dict[str, MetricOutput],
) -> List[Dict[str, Any]]:
    in_lcc = {str(node): True for node in lcc.nodes()}
    rows: List[Dict[str, Any]] = []
    for node_id, attrs in sorted(graph.nodes(data=True), key=lambda item: str(item[0])):
        node_key = str(node_id)
        row: Dict[str, Any] = {
            "stop_id": node_key,
            "stop_name": attrs.get("stop_name") or node_key,
            "lat": attrs.get("lat"),
            "lon": attrs.get("lon"),
            "borough": attrs.get("borough") or "",
            "in_lcc": bool(in_lcc.get(node_key, False)),
        }
        if row["in_lcc"]:
            for metric_key in ("degree", "betweenness", "closeness"):
                metric = metrics.get(metric_key)
                row[metric_key] = metric.values.get(node_key) if metric else None
                row[f"{metric_key}_rank"] = metric.ranks.get(node_key) if metric else None
                row[f"{metric_key}_percentile"] = metric.percentiles.get(node_key) if metric else None
        else:
            for metric_key in ("degree", "betweenness", "closeness"):
                row[metric_key] = None
                row[f"{metric_key}_rank"] = None
                row[f"{metric_key}_percentile"] = None
        rows.append(row)
    return rows


def write_metrics_csv(output_path: Path, rows: List[Dict[str, Any]]) -> None:
    columns = [
        "stop_id",
        "stop_name",
        "lat",
        "lon",
        "borough",
        "in_lcc",
        "degree",
        "degree_rank",
        "degree_percentile",
        "betweenness",
        "betweenness_rank",
        "betweenness_percentile",
        "closeness",
        "closeness_rank",
        "closeness_percentile",
    ]
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            formatted = {}
            for key in columns:
                value = row.get(key)
                if value is None:
                    formatted[key] = ""
                elif isinstance(value, bool):
                    formatted[key] = "true" if value else "false"
                elif isinstance(value, float):
                    formatted[key] = f"{value:.6f}"
                else:
                    formatted[key] = value
            writer.writerow(formatted)


def _median(values: List[float]) -> float:
    if not values:
        return 0.0
    return float(statistics.median(values))


def print_sanity_report(
    graph: nx.Graph,
    lcc: nx.Graph,
    metrics: Dict[str, MetricOutput],
) -> None:
    total_nodes = graph.number_of_nodes()
    total_edges = graph.number_of_edges()
    components = list(nx.connected_components(graph))
    lcc_size = lcc.number_of_nodes()
    lcc_pct = 100.0 * lcc_size / float(total_nodes) if total_nodes else 0.0

    _log("Sanity report:")
    _log(f"Total stops: {total_nodes}")
    _log(f"Total edges: {total_edges}")
    _log(f"Connected components: {len(components)}")
    _log(f"LCC size: {lcc_size} ({lcc_pct:.2f}%)")

    degree_vals = list(metrics.get("degree", MetricOutput({}, {}, {})).values.values())
    if degree_vals:
        _log(f"Degree: min={min(degree_vals)} max={max(degree_vals)} median={_median(degree_vals)}")

    bet_vals = list(metrics.get("betweenness", MetricOutput({}, {}, {})).values.values())
    if bet_vals:
        zeros = sum(1 for value in bet_vals if value == 0.0)
        pct_zero = 100.0 * zeros / float(len(bet_vals)) if bet_vals else 0.0
        _log(f"Betweenness: min={min(bet_vals)} max={max(bet_vals)} zeros={pct_zero:.2f}%")

    close_vals = list(metrics.get("closeness", MetricOutput({}, {}, {})).values.values())
    if close_vals:
        _log(f"Closeness: min={min(close_vals)} max={max(close_vals)}")

    def _top(metric_key: str, label: str) -> None:
        metric = metrics.get(metric_key)
        if not metric:
            return
        ordered = sorted(metric.values.items(), key=lambda item: (-item[1], item[0]))[:10]
        lines = []
        for node_id, value in ordered:
            attrs = graph.nodes[node_id] if node_id in graph.nodes else {}
            name = attrs.get("stop_name") or attrs.get("stop_id") or node_id
            lines.append(f"{name} ({node_id}): {value:.6f}")
        _log(f"Top 10 {label}: " + " | ".join(lines))

    _top("degree", "degree")
    _top("betweenness", "betweenness")
    _top("closeness", "closeness")
