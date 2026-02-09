from __future__ import annotations

import json
from pathlib import Path

from scripts.stop_analysis.centrality import build_output_rows, compute_metrics_on_lcc
from scripts.stop_analysis.graph import build_stop_graph


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def test_stop_graph_edges_from_sequences(tmp_path: Path) -> None:
    stops_path = tmp_path / "stops.geojson"
    stops = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [0.0, 0.0]}, "properties": {"NAPTAN_ID": "A", "NAME": "A"}},
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [0.01, 0.0]}, "properties": {"NAPTAN_ID": "B", "NAME": "B"}},
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [0.02, 0.0]}, "properties": {"NAPTAN_ID": "C", "NAME": "C"}},
        ],
    }
    _write_json(stops_path, stops)

    seq_path = tmp_path / "sequences.jsonl"
    seq_lines = [
        {"route_id": "1", "direction": "outbound", "stops": ["A", "B", "C"]},
        {"route_id": "2", "direction": "outbound", "stops": ["A", "B"]},
    ]
    with seq_path.open("w", encoding="utf-8") as handle:
        for row in seq_lines:
            handle.write(json.dumps(row))
            handle.write("\n")

    graph, _index, stats = build_stop_graph(stops_path, seq_path)
    assert graph.number_of_nodes() == 3
    assert graph.number_of_edges() == 2
    assert stats["edges_added_raw"] == 3


def test_metrics_lcc_only(tmp_path: Path) -> None:
    stops_path = tmp_path / "stops.geojson"
    stops = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [0.0, 0.0]}, "properties": {"NAPTAN_ID": "A", "NAME": "A"}},
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [0.01, 0.0]}, "properties": {"NAPTAN_ID": "B", "NAME": "B"}},
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [0.02, 0.0]}, "properties": {"NAPTAN_ID": "C", "NAME": "C"}},
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [1.0, 1.0]}, "properties": {"NAPTAN_ID": "D", "NAME": "D"}},
        ],
    }
    _write_json(stops_path, stops)

    seq_path = tmp_path / "sequences.jsonl"
    seq_lines = [
        {"route_id": "1", "direction": "outbound", "stops": ["A", "B", "C"]},
    ]
    with seq_path.open("w", encoding="utf-8") as handle:
        for row in seq_lines:
            handle.write(json.dumps(row))
            handle.write("\n")

    graph, _index, _stats = build_stop_graph(stops_path, seq_path)
    lcc, metrics = compute_metrics_on_lcc(graph)
    rows = build_output_rows(graph, lcc, metrics)
    row_by_id = {row["stop_id"]: row for row in rows}

    assert row_by_id["D"]["in_lcc"] is False
    assert row_by_id["D"]["degree"] is None
    assert row_by_id["A"]["in_lcc"] is True
