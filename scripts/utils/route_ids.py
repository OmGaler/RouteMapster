from __future__ import annotations

import logging
from pathlib import Path
from typing import Set, Union


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_GEOM_DIR = REPO_ROOT / "data" / "processed" / "routes"
EXCLUDED_PREFIXES = ("UL", "T")


def normalize_route_id(raw: object) -> str:
    if raw is None:
        return ""
    return str(raw).strip().upper()


def is_excluded_route_id(route_id: object) -> bool:
    text = normalize_route_id(route_id)
    if not text:
        return False
    if text.startswith("UL"):
        return True
    if text.startswith("T") and len(text) > 1 and text[1].isdigit():
        return True
    return False


def is_700_series(route_id: object) -> bool:
    text = normalize_route_id(route_id)
    if not text.isdigit():
        return False
    value = int(text)
    return 700 <= value <= 799


def active_routes_from_geometry(geom_dir: Union[Path, str] = DEFAULT_GEOM_DIR) -> Set[str]:
    path = Path(geom_dir)
    if not path.exists():
        return set()
    routes: Set[str] = set()
    for geojson_path in path.glob("*.geojson"):
        route_id = normalize_route_id(geojson_path.stem)
        if not route_id:
            continue
        if is_excluded_route_id(route_id):
            continue
        if is_700_series(route_id):
            continue
        routes.add(route_id)
    return routes


def reconcile_possible_ghost_night_route(route_id: object, active_routes: Set[str]) -> str:
    normalized = normalize_route_id(route_id)
    if not normalized:
        return ""
    if normalized.startswith("N") and normalized not in active_routes:
        day = normalized[1:]
        if day and day in active_routes:
            logging.getLogger(__name__).debug(
                "Reconciled ghost night route %s -> %s (%s not active; %s active)",
                normalized,
                day,
                normalized,
                day,
            )
            return day
    return normalized
