import argparse
import json
import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path

try:
    from scripts.utils.route_ids import normalize_route_id
except ModuleNotFoundError:  # pragma: no cover - script execution fallback
    from utils.route_ids import normalize_route_id

ROUTE_PATTERN = re.compile(r"Route_Geometry_(.+)_(\d{8})\.xml$", re.IGNORECASE)


def is_700_series(route_id: str) -> bool:
    text = normalize_route_id(route_id)
    if not text.isdigit():
        return False
    value = int(text)
    return 700 <= value <= 799


def parse_route_segments(path):
    try:
        tree = ET.parse(path)
    except ET.ParseError:
        return []

    root = tree.getroot()
    groups = {}
    for node in root.findall(".//Route_Geometry"):
        seq_raw = node.get("aSequence_No") or "0"
        run = node.get("aLBSL_Run_No") or ""
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
        key = f"{run}-{direction}"
        groups.setdefault(key, []).append((seq, lon, lat))

    segments = []
    for points in groups.values():
        points.sort(key=lambda item: item[0])
        coords = [[lon, lat] for _, lon, lat in points]
        if len(coords) > 1:
            segments.append(coords)
    return segments


def guess_date_token(input_dir, fallback):
    match = re.search(r"(\d{8})", Path(input_dir).name)
    if match:
        return match.group(1)
    return fallback


def build_feature(route_id, date_token, segments):
    if len(segments) == 1:
        geometry = {"type": "LineString", "coordinates": segments[0]}
    else:
        geometry = {"type": "MultiLineString", "coordinates": segments}
    return {
        "type": "Feature",
        "properties": {"routeId": route_id, "date": date_token},
        "geometry": geometry
    }


def convert(input_dir, output_path):
    input_path = Path(input_dir)
    if not input_path.exists():
        raise FileNotFoundError(f"Input dir not found: {input_dir}")

    features = []
    date_tokens = []
    for path in sorted(input_path.glob("Route_Geometry_*_*.xml")):
        match = ROUTE_PATTERN.match(path.name)
        if not match:
            continue
        route_id = normalize_route_id(match.group(1))
        if is_700_series(route_id):
            continue
        date_token = match.group(2)
        segments = parse_route_segments(path)
        if not segments:
            continue
        features.append(build_feature(route_id, date_token, segments))
        date_tokens.append(date_token)

    date_token = guess_date_token(input_dir, date_tokens[0] if date_tokens else "unknown")
    if output_path is None:
        output_path = input_path.parent / f"route_geometry_{date_token}.geojson"
    else:
        output_path = Path(output_path)

    geojson = {"type": "FeatureCollection", "features": features}
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(geojson, handle, ensure_ascii=True, separators=(",", ":"))

    return output_path, len(features)


def main():
    parser = argparse.ArgumentParser(description="Convert route geometry XMLs into a GeoJSON FeatureCollection.")
    parser.add_argument("--input-dir", required=True, help="Directory containing Route_Geometry_*.xml files.")
    parser.add_argument("--output", help="Output GeoJSON path (defaults to data/route_geometry_<date>.geojson).")
    args = parser.parse_args()

    output_path, feature_count = convert(args.input_dir, args.output)
    print(f"Wrote {feature_count} route geometries to {output_path}")


if __name__ == "__main__":
    main()
