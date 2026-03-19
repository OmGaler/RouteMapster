#!/usr/bin/env python3
"""
reallocate_routes.py

Move bus routes from one garage to another inside an existing garages GeoJSON.

Examples:
Move a single route:
python reallocate_routes.py ../data/processed/garages.geojson 142 X BT

# Apply a batch file of moves (lines: route from to):
python reallocate_routes.py ../data/processed/garages.geojson moves.txt

moves.txt example:
1 Q W
24 NX SW

Updates GeoJSON in-place unless --out is provided

Will throw an error if:
- route cannot be found in any garage
- route is not at the specified source garage
- either garage code does not exist in the GeoJSON
- route is found in multiple garages (ambiguous)
"""

from __future__ import annotations

import argparse, json, logging, re
from pathlib import Path
from typing import Any, Dict, List, Tuple

try:
    from scripts.utils.route_ids import normalize_route_id
except ModuleNotFoundError:  # pragma: no cover - script execution fallback
    from utils.route_ids import normalize_route_id

GARAGE_CODE_KEY = "TfL garage code"
GARAGE_CODE_FALLBACK_KEY = "LBR garage code"

ROUTE_FIELDS = [
    "TfL main network routes",
    "TfL night routes",
    "TfL school/mobility routes",
    "Other routes",
]

DESTINATION_FIELD = "TfL main network routes"


class ReallocationError(Exception):
    """Raised when a requested route move cannot be applied safely."""
    pass


def setup_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s | %(levelname)s | %(message)s",
        datefmt="%H:%M:%S",
    )


def norm_code(s: str) -> str:
    return (s or "").strip().upper()


def norm_route(s: str) -> str:
    return normalize_route_id(s)


def load_geojson(path: Path) -> Dict[str, Any]:
    if not path.exists():
        raise ReallocationError(f"GeoJSON not found: {path}")
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        raise ReallocationError(f"Failed to read GeoJSON '{path}': {e}") from e

    if not isinstance(data, dict) or data.get("type") != "FeatureCollection":
        raise ReallocationError(f"GeoJSON '{path}' is not a FeatureCollection")
    if not isinstance(data.get("features"), list):
        raise ReallocationError(f"GeoJSON '{path}' has no valid 'features' list")
    return data


def save_geojson(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_feature_code(feat: Dict[str, Any]) -> str:
    props = feat.get("properties") or {}
    if not isinstance(props, dict):
        return ""
    code = props.get(GARAGE_CODE_KEY) or props.get(GARAGE_CODE_FALLBACK_KEY) or ""
    return norm_code(str(code))


def split_routes(val: Any) -> List[str]:
    # Routes are stored like "142 204 240 251 " -> ["142","204","240","251"]
    if val is None:
        return []
    s = str(val).strip()
    if not s:
        return []
    return [p for p in re.split(r"\s+", s) if p]


def join_routes(routes: List[str]) -> str:
    # Simple normalised output: single spaces, no trailing space
    return " ".join(routes)


def build_garage_index(geojson: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    idx: Dict[str, Dict[str, Any]] = {}
    for feat in geojson.get("features", []) or []:
        if not isinstance(feat, dict):
            continue
        code = get_feature_code(feat)
        if code:
            idx[code] = feat
    return idx


def find_route(geojson: Dict[str, Any], route: str) -> List[Tuple[str, str]]:
    """
    Return list of (garage_code, field_name) where route is found.
    """
    r = norm_route(route)
    hits: List[Tuple[str, str]] = []

    for feat in geojson.get("features", []) or []:
        if not isinstance(feat, dict):
            continue
        code = get_feature_code(feat)
        if not code:
            continue

        props = feat.get("properties") or {}
        if not isinstance(props, dict):
            continue

        for field in ROUTE_FIELDS:
            routes = split_routes(props.get(field, ""))
            if r in routes:
                hits.append((code, field))

    return hits


def add_route_to_field(props: Dict[str, Any], field: str, route: str) -> None:
    routes = split_routes(props.get(field, ""))
    if route not in routes:
        routes.append(route)

    # Keep tidy: numeric routes sorted numerically; others afterwards
    def sort_key(x: str) -> Tuple[int, str]:
        return (0, f"{int(x):06d}") if x.isdigit() else (1, x.upper())

    routes = sorted(routes, key=sort_key)
    props[field] = join_routes(routes)


def remove_route_from_field(props: Dict[str, Any], field: str, route: str) -> None:
    routes = split_routes(props.get(field, ""))
    if route not in routes:
        raise ReallocationError(f"Route '{route}' is not in field '{field}' at the source garage")
    routes = [x for x in routes if x != route]
    props[field] = join_routes(routes)


def apply_move(geojson: Dict[str, Any], route: str, src: str, dst: str) -> None:
    route = norm_route(route)
    src = norm_code(src)
    dst = norm_code(dst)

    idx = build_garage_index(geojson)
    if src not in idx:
        raise ReallocationError(f"Invalid source garage code: {src}")
    if dst not in idx:
        raise ReallocationError(f"Invalid destination garage code: {dst}")

    hits = find_route(geojson, route)
    if not hits:
        raise ReallocationError(f"Route '{route}' cannot be found in any garage")
    if len(hits) > 1:
        garages = ", ".join(sorted({c for c, _ in hits}))
        raise ReallocationError(f"Route '{route}' found in multiple garages: {garages}")

    found_code, found_field = hits[0]
    if found_code != src:
        raise ReallocationError(
            f"Route '{route}' is not at source garage '{src}' (it is at '{found_code}')"
        )

    src_feat = idx[src]
    dst_feat = idx[dst]

    src_props = src_feat.get("properties") or {}
    dst_props = dst_feat.get("properties") or {}
    if not isinstance(src_props, dict) or not isinstance(dst_props, dict):
        raise ReallocationError("Invalid GeoJSON properties structure")

    remove_route_from_field(src_props, found_field, route)
    add_route_to_field(dst_props, DESTINATION_FIELD, route)

    src_feat["properties"] = src_props
    dst_feat["properties"] = dst_props

    logging.info("Moved route %s from %s (%s) to %s (%s)", route, src, found_field, dst, DESTINATION_FIELD)


def parse_moves_file(path: Path) -> List[Tuple[str, str, str]]:
    if not path.exists():
        raise ReallocationError(f"Moves file not found: {path}")

    moves: List[Tuple[str, str, str]] = []
    with path.open("r", encoding="utf-8") as f:
        for ln, raw in enumerate(f, start=1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = re.split(r"\s+", line)
            if len(parts) != 3:
                raise ReallocationError(f"Invalid line {ln} in moves file: {raw.rstrip()}")
            moves.append((parts[0], parts[1], parts[2]))

    if not moves:
        raise ReallocationError(f"No moves found in file: {path}")
    return moves


def main() -> int:
    """Apply one or more garage reallocation moves to the processed GeoJSON.

    Returns:
        Process exit code for CLI usage.

    Side effects:
        Reads and rewrites the processed garage GeoJSON and logs any failures.
    """
    ap = argparse.ArgumentParser()
    ap.add_argument("geojson", type=str, help="Garages GeoJSON FeatureCollection")
    ap.add_argument("move_spec", nargs="+", help="Either: ROUTE FROM TO OR a .txt file of moves")
    ap.add_argument("--out", type=str, default="", help="Output GeoJSON (default: overwrite input)")
    ap.add_argument("--verbose", action="store_true", help="Verbose logging")
    args = ap.parse_args()

    setup_logging(args.verbose)

    in_path = Path(args.geojson)
    out_path = Path(args.out) if args.out else in_path

    try:
        data = load_geojson(in_path)

        if len(args.move_spec) == 1 and args.move_spec[0].lower().endswith(".txt"):
            moves = parse_moves_file(Path(args.move_spec[0]))
        elif len(args.move_spec) == 3:
            moves = [(args.move_spec[0], args.move_spec[1], args.move_spec[2])]
        else:
            raise ReallocationError(
                "Invalid invocation.\n"
                "Use either:\n"
                "  reallocate_routes.py data/processed/garages.geojson ROUTE FROM TO\n"
                "or:\n"
                "  reallocate_routes.py data/processed/garages.geojson moves.txt"
            )

        for route, src, dst in moves:
            apply_move(data, route, src, dst)

        save_geojson(out_path, data)
        logging.info("Wrote updated GeoJSON to %s", out_path)
        return 0

    except ReallocationError as e:
        logging.error(str(e))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
