#!/usr/bin/env python3
"""
Build a compact route-geometry bundle from processed per-route GeoJSON files.

The output keeps only the geometry segments the browser actually renders,
stored in `[lat, lon]` order so the client can populate its cache directly
without reparsing full GeoJSON feature collections.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Dict, Iterable, List, Optional

try:
    from scripts.utils.route_ids import normalize_route_id
except ModuleNotFoundError:  # pragma: no cover - script execution fallback
    from utils.route_ids import normalize_route_id

DEFAULT_ROUTES_DIR = Path("data/processed/routes")
DEFAULT_INDEX_PATH = DEFAULT_ROUTES_DIR / "index.json"
DEFAULT_BUNDLE_PATH = Path("data/processed/route_geometry.bundle.json")


def extract_geometry_segments(geometry: object) -> List[List[List[float]]]:
    if not isinstance(geometry, dict):
        return []

    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if geometry_type == "LineString":
        return [normalise_segment(coordinates)]
    if geometry_type == "MultiLineString" and isinstance(coordinates, list):
        return [segment for segment in (normalise_segment(item) for item in coordinates) if len(segment) > 1]
    return []


def normalise_segment(points: object) -> List[List[float]]:
    if not isinstance(points, list):
        return []

    segment: List[List[float]] = []
    for point in points:
        if not isinstance(point, list) or len(point) < 2:
            continue
        lon = to_finite_float(point[0])
        lat = to_finite_float(point[1])
        if lon is None or lat is None:
            continue
        segment.append([lat, lon])
    return segment if len(segment) > 1 else []


def to_finite_float(value: object) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def load_route_segments(path: Path) -> List[List[List[float]]]:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)

    segments: List[List[List[float]]] = []
    features = payload.get("features") if isinstance(payload, dict) else None
    if not isinstance(features, list):
        return segments

    for feature in features:
        geometry = feature.get("geometry") if isinstance(feature, dict) else None
        for segment in extract_geometry_segments(geometry):
            if len(segment) > 1:
                segments.append(segment)
    return segments


def load_route_ids(routes_dir: Path, index_path: Path) -> List[str]:
    if index_path.exists():
        with index_path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
        routes = payload.get("routes") if isinstance(payload, dict) else None
        if isinstance(routes, list):
            return [
                route_id
                for route_id in (normalize_route_id(item) for item in routes)
                if route_id
            ]

    route_ids = []
    for path in sorted(routes_dir.glob("*.geojson")):
        route_id = normalize_route_id(path.stem)
        if route_id:
            route_ids.append(route_id)
    return route_ids


def load_index_metadata(index_path: Path) -> Dict[str, object]:
    if not index_path.exists():
        return {}
    with index_path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, dict) else {}


def write_json(path: Path, payload: Dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=True, separators=(",", ":"))


def build_route_geometry_bundle(
    routes_dir: Path = DEFAULT_ROUTES_DIR,
    index_path: Path = DEFAULT_INDEX_PATH,
    bundle_path: Path = DEFAULT_BUNDLE_PATH,
) -> Dict[str, object]:
    route_ids = load_route_ids(routes_dir, index_path)
    metadata = load_index_metadata(index_path)

    routes_payload: Dict[str, List[List[List[float]]]] = {}
    for route_id in route_ids:
        route_path = routes_dir / f"{route_id}.geojson"
        if not route_path.exists():
            continue
        segments = load_route_segments(route_path)
        if segments:
            routes_payload[route_id] = segments

    payload = {
        "date": metadata.get("date"),
        "source": metadata.get("source"),
        "routeCount": len(routes_payload),
        "routes": routes_payload,
    }
    write_json(bundle_path, payload)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the compact RouteMapster route-geometry bundle.")
    parser.add_argument("--routes-dir", default=str(DEFAULT_ROUTES_DIR), help="Directory containing per-route GeoJSON.")
    parser.add_argument("--index-path", default=str(DEFAULT_INDEX_PATH), help="Path to routes index.json.")
    parser.add_argument("--bundle-path", default=str(DEFAULT_BUNDLE_PATH), help="Output path for bundle JSON.")
    args = parser.parse_args()

    payload = build_route_geometry_bundle(
        routes_dir=Path(args.routes_dir),
        index_path=Path(args.index_path),
        bundle_path=Path(args.bundle_path),
    )
    print(f"Wrote route bundle with {payload['routeCount']} routes to {args.bundle_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
