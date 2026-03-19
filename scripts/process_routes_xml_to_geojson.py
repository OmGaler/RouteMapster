#!/usr/bin/env python3
"""
Convert TfL bus route geometry XML files into per-route GeoJSON files.

Input is a folder containing Route_Geometry_<route>_<YYYYMMDD>.xml files.
Outputs a FeatureCollection per route plus an index.json manifest.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

try:
    from scripts.utils.route_ids import normalize_route_id
except ModuleNotFoundError:  # pragma: no cover - script execution fallback
    from utils.route_ids import normalize_route_id

ROUTE_PATTERN = re.compile(r"Route_Geometry_([A-Za-z0-9]+)_(\d{8})\.xml$", re.IGNORECASE)
DEFAULT_OUTPUT_DIR = Path("data/processed/routes")
DEFAULT_INDEX_PATH = DEFAULT_OUTPUT_DIR / "index.json"


def is_700_series(route_id: str) -> bool:
    text = normalize_route_id(route_id)
    if not text.isdigit():
        return False
    value = int(text)
    return 700 <= value <= 799


def round_coord(value: float, precision: int) -> float:
    rounded = round(value, precision)
    if rounded == -0.0:
        return 0.0
    return rounded


def simplify_line(points: List[Tuple[float, float]], tolerance: float) -> List[Tuple[float, float]]:
    if tolerance <= 0 or len(points) <= 2:
        return points

    def distance(p: Tuple[float, float], a: Tuple[float, float], b: Tuple[float, float]) -> float:
        ax, ay = a
        bx, by = b
        px, py = p
        dx = bx - ax
        dy = by - ay
        if dx == 0 and dy == 0:
            return math.hypot(px - ax, py - ay)
        t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
        t = max(0.0, min(1.0, t))
        proj = (ax + t * dx, ay + t * dy)
        return math.hypot(px - proj[0], py - proj[1])

    max_dist = 0.0
    index = 0
    start = points[0]
    end = points[-1]
    for i in range(1, len(points) - 1):
        dist = distance(points[i], start, end)
        if dist > max_dist:
            max_dist = dist
            index = i

    if max_dist > tolerance:
        left = simplify_line(points[: index + 1], tolerance)
        right = simplify_line(points[index:], tolerance)
        return left[:-1] + right
    return [start, end]


def parse_route_segments(path: Path) -> Dict[str, List[List[Tuple[float, float]]]]:
    try:
        tree = ET.parse(path)
    except ET.ParseError:
        return {}

    root = tree.getroot()
    groups: Dict[str, Dict[str, List[Tuple[int, float, float]]]] = {}
    for node in root.findall(".//Route_Geometry"):
        seq_raw = node.get("aSequence_No") or "0"
        run = (node.get("aLBSL_Run_No") or "").strip()
        direction = (node.findtext("Direction") or "").strip()
        lat_raw = node.findtext("Location_Latitude")
        lon_raw = node.findtext("Location_Longitude")
        try:
            seq = int(seq_raw)
            lat = float(lat_raw)
            lon = float(lon_raw)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(lat) or not math.isfinite(lon):
            continue
        groups.setdefault(direction, {}).setdefault(run, []).append((seq, lon, lat))

    direction_segments: Dict[str, List[List[Tuple[float, float]]]] = {}
    for direction, runs in groups.items():
        segments: List[List[Tuple[float, float]]] = []
        for points in runs.values():
            points.sort(key=lambda item: item[0])
            coords = [(lon, lat) for _, lon, lat in points]
            if len(coords) > 1:
                segments.append(coords)
        if segments:
            direction_segments[direction] = segments
    return direction_segments


def build_features(
    route_id: str,
    date_token: str,
    direction_segments: Dict[str, List[List[Tuple[float, float]]]],
    tolerance: float,
    precision: int,
) -> List[Dict[str, object]]:
    features = []
    for direction in sorted(direction_segments.keys()):
        segments = []
        for segment in direction_segments[direction]:
            simplified = simplify_line(segment, tolerance)
            if len(simplified) < 2:
                simplified = segment
            rounded = [(round_coord(lon, precision), round_coord(lat, precision)) for lon, lat in simplified]
            if len(rounded) > 1:
                segments.append([[lon, lat] for lon, lat in rounded])
        if not segments:
            continue
        if len(segments) == 1:
            geometry = {"type": "LineString", "coordinates": segments[0]}
        else:
            geometry = {"type": "MultiLineString", "coordinates": segments}
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "routeId": route_id,
                    "direction": direction,
                    "sourceDate": date_token,
                },
                "geometry": geometry,
            }
        )
    return features


def write_json(path: Path, payload: Dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=True, separators=(",", ":"))


def load_latest_input(latest_file: Path) -> Path:
    if not latest_file.exists():
        raise FileNotFoundError(f"Latest file not found: {latest_file}")
    with latest_file.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    date_token = payload.get("date")
    if not date_token:
        raise ValueError(f"Latest file missing date: {latest_file}")
    return Path("data/raw/tfl_routes") / date_token


def cleanup_stale_routes(output_dir: Path, keep_routes: Iterable[str]) -> None:
    keep = {normalize_route_id(route) for route in keep_routes if normalize_route_id(route)}
    for path in output_dir.glob("*.geojson"):
        if path.name == "index.json":
            continue
        route_id = normalize_route_id(path.stem)
        if route_id not in keep:
            path.unlink()


def main() -> int:
    """Convert raw TfL route XML files into processed per-route GeoJSON.

    Returns:
        Process exit code for CLI usage.

    Side effects:
        Reads raw XML geometry files, writes processed GeoJSON files, and
        refreshes the route index manifest.
    """
    parser = argparse.ArgumentParser(description="Convert TfL route geometry XMLs into GeoJSON files.")
    parser.add_argument("--input-dir", help="Directory containing Route_Geometry_*.xml files.")
    parser.add_argument(
        "--latest-file",
        default="data/raw/tfl_routes/latest.json",
        help="Latest metadata JSON file from fetch_tfl_routes.py.",
    )
    parser.add_argument(
        "--output-dir",
        default=str(DEFAULT_OUTPUT_DIR),
        help="Output directory for per-route GeoJSON.",
    )
    parser.add_argument(
        "--index-path",
        default=str(DEFAULT_INDEX_PATH),
        help="Output path for routes index.json.",
    )
    parser.add_argument(
        "--simplify",
        type=float,
        default=0.00005,
        help="Douglas-Peucker tolerance in degrees for simplification.",
    )
    parser.add_argument("--precision", type=int, default=6, help="Decimal precision for coordinates.")
    args = parser.parse_args()

    input_dir = Path(args.input_dir) if args.input_dir else load_latest_input(Path(args.latest_file))
    if not input_dir.exists():
        raise FileNotFoundError(f"Input dir not found: {input_dir}")

    output_dir = Path(args.output_dir)
    index_path = Path(args.index_path)
    output_dir.mkdir(parents=True, exist_ok=True)

    route_ids: List[str] = []
    date_token = None

    for path in sorted(input_dir.glob("Route_Geometry_*_*.xml")):
        match = ROUTE_PATTERN.match(path.name)
        if not match:
            continue
        route_id = normalize_route_id(match.group(1))
        if is_700_series(route_id):
            continue
        date_token = match.group(2)
        direction_segments = parse_route_segments(path)
        if not direction_segments:
            continue
        features = build_features(route_id, date_token, direction_segments, args.simplify, args.precision)
        if not features:
            continue

        payload = {
            "type": "FeatureCollection",
            "metadata": {
                "routeId": route_id,
                "sourceDate": date_token,
                "source": "https://bus.data.tfl.gov.uk/bus-geometry/",
            },
            "features": features,
        }
        write_json(output_dir / f"{route_id}.geojson", payload)
        route_ids.append(route_id)

    route_ids_sorted = sorted(set(route_ids))
    if not route_ids_sorted:
        raise SystemExit("No route geometries written.")

    if date_token is None:
        date_token = "unknown"

    cleanup_stale_routes(output_dir, route_ids_sorted)

    index_payload = {
        "date": date_token,
        "routes": route_ids_sorted,
        "source": "https://bus.data.tfl.gov.uk/bus-geometry/",
    }
    write_json(index_path, index_payload)

    print(f"Wrote {len(route_ids_sorted)} routes to {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
