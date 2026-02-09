from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import networkx as nx

try:
    from scripts.stop_analysis.common import extract_stop_id, extract_stop_name, iter_json_lines, load_json, utc_now_iso
except ModuleNotFoundError:  # pragma: no cover - script execution fallback
    from stop_analysis.common import extract_stop_id, extract_stop_name, iter_json_lines, load_json, utc_now_iso


@dataclass
class RouteSequence:
    route_id: str
    direction: Optional[str]
    stops: List[str]


def _log(message: str) -> None:
    print(f"[{utc_now_iso()}] {message}")


def _clean_stop_id(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _as_stop_list(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    stops: List[str] = []
    for item in value:
        stop_id = _clean_stop_id(item)
        if stop_id:
            stops.append(stop_id)
    return stops


def _extract_sequences_from_entry(entry: Dict[str, Any]) -> List[RouteSequence]:
    route_id = entry.get("route_id") or entry.get("routeId") or entry.get("route") or entry.get("lineId") or entry.get("id")
    route_id = _clean_stop_id(route_id)
    direction = entry.get("direction") or entry.get("dir")

    sequences: List[RouteSequence] = []
    if not route_id:
        return sequences

    stops = _as_stop_list(entry.get("stops")) or _as_stop_list(entry.get("stop_ids")) or _as_stop_list(entry.get("stopIds"))
    if stops:
        sequences.append(RouteSequence(route_id=route_id, direction=direction, stops=stops))
        return sequences

    if isinstance(entry.get("stopPointSequences"), list):
        for seq in entry.get("stopPointSequences", []):
            if not isinstance(seq, dict):
                continue
            seq_direction = seq.get("direction") or direction
            seq_stops = _as_stop_list(seq.get("stopPoint") or seq.get("stopPoints") or seq.get("stops"))
            if seq_stops:
                sequences.append(RouteSequence(route_id=route_id, direction=seq_direction, stops=seq_stops))
    return sequences


def load_route_sequences(path: Path) -> List[RouteSequence]:
    if not path.exists():
        raise FileNotFoundError(f"Route sequences file not found: {path}")

    sequences: List[RouteSequence] = []
    if path.suffix.lower() == ".jsonl":
        for entry in iter_json_lines(path):
            if isinstance(entry, dict):
                sequences.extend(_extract_sequences_from_entry(entry))
        return sequences

    payload = load_json(path)
    if isinstance(payload, list):
        items: Iterable[Any] = payload
    elif isinstance(payload, dict):
        items = payload.get("routes") or payload.get("sequences") or payload.get("entries") or []
    else:
        items = []

    for entry in items:
        if isinstance(entry, dict):
            sequences.extend(_extract_sequences_from_entry(entry))
    return sequences


def load_stops(stops_path: Path) -> Tuple[List[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    payload = load_json(stops_path)
    features = payload.get("features") if isinstance(payload, dict) else None
    if not isinstance(features, list):
        raise ValueError(f"Stops GeoJSON missing features: {stops_path}")

    stops: List[Dict[str, Any]] = []
    stop_index: Dict[str, Dict[str, Any]] = {}
    for feat in features:
        if not isinstance(feat, dict):
            continue
        props = feat.get("properties") or {}
        stop_id = extract_stop_id(props)
        if not stop_id:
            continue
        geom = feat.get("geometry") or {}
        coords = geom.get("coordinates") if isinstance(geom, dict) else None
        if not isinstance(coords, list) or len(coords) < 2:
            continue
        lon = coords[0]
        lat = coords[1]
        if not isinstance(lon, (int, float)) or not isinstance(lat, (int, float)):
            continue
        borough = props.get("borough") or props.get("BOROUGH") or props.get("Borough")
        stop = {
            "stop_id": str(stop_id),
            "stop_name": extract_stop_name(props) or str(stop_id),
            "lat": float(lat),
            "lon": float(lon),
            "borough": str(borough).strip() if borough else "",
        }
        stops.append(stop)
        stop_index[str(stop_id)] = stop
    return stops, stop_index


def build_stop_graph(
    stops_path: Path,
    sequences_path: Path,
) -> Tuple[nx.Graph, Dict[str, Dict[str, Any]], Dict[str, Any]]:
    stops, stop_index = load_stops(stops_path)
    sequences = load_route_sequences(sequences_path)
    if not sequences:
        raise SystemExit("No route sequences found. Provide a valid ordered stop sequence file.")

    graph = nx.Graph()
    for stop in stops:
        graph.add_node(stop["stop_id"], **stop)

    edges_added_raw = 0
    sequence_len_raw = 0
    sequence_len_mapped = 0
    route_ids = set()
    sequence_count = 0
    missing_stops = 0

    for seq in sequences:
        if not seq.route_id:
            continue
        route_ids.add(seq.route_id)
        sequence_len_raw += len(seq.stops)
        collapsed: List[str] = []
        prev = None
        for stop_id in seq.stops:
            if stop_id not in stop_index:
                missing_stops += 1
                continue
            if stop_id == prev:
                continue
            collapsed.append(stop_id)
            prev = stop_id
        if len(collapsed) < 2:
            continue
        sequence_count += 1
        sequence_len_mapped += len(collapsed)
        for u, v in zip(collapsed, collapsed[1:]):
            if u == v:
                continue
            edges_added_raw += 1
            graph.add_edge(u, v)

    if graph.number_of_edges() == 0:
        raise SystemExit("No edges were created from route sequences. Check that stop IDs match.")

    stats = {
        "stop_count": len(stops),
        "edge_count": graph.number_of_edges(),
        "sequence_count": sequence_count,
        "unique_routes": len(route_ids),
        "sequence_len_raw": sequence_len_raw,
        "sequence_len_mapped": sequence_len_mapped,
        "edges_added_raw": edges_added_raw,
        "missing_stops": missing_stops,
    }
    return graph, stop_index, stats


def print_graph_summary(stats: Dict[str, Any]) -> None:
    _log(
        "Graph build: "
        f"stops={stats.get('stop_count')} "
        f"edges={stats.get('edge_count')} "
        f"routes={stats.get('unique_routes')} "
        f"sequences={stats.get('sequence_count')} "
        f"seq_len_raw={stats.get('sequence_len_raw')} "
        f"seq_len_mapped={stats.get('sequence_len_mapped')} "
        f"edges_added_raw={stats.get('edges_added_raw')} "
        f"missing_stops={stats.get('missing_stops')}"
    )
