"""
Normalise and classify route identifiers used throughout the data pipeline.

These helpers keep route naming consistent across scripts, tests, processed
geometry files, and garage allocations.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Set, Union


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_GEOM_DIR = REPO_ROOT / "data" / "processed" / "routes"
EXCLUDED_PREFIXES = ("UL", "T")
EXCLUDED_ROUTES = {"SCS"}


def normalize_route_id(raw: object) -> str:
    """Normalise a route identifier into the canonical upper-case token.

    Args:
        raw: Raw route identifier from a dataset, file name, or user input.

    Returns:
        The stripped upper-case route id, or an empty string when absent.
    """
    if raw is None:
        return ""
    return str(raw).strip().upper()


def is_excluded_route_id(route_id: object) -> bool:
    """Return whether a route id should be ignored by the standard pipeline.

    Args:
        route_id: Raw route identifier to classify.

    Returns:
        `True` when the id represents an excluded special service.
    """
    text = normalize_route_id(route_id)
    if not text:
        return False
    if text in EXCLUDED_ROUTES:
        return True
    if text.startswith("UL"):
        return True
    if text.startswith("T") and len(text) > 1 and text[1].isdigit():
        return True
    return False


def is_700_series(route_id: object) -> bool:
    """Return whether a route id belongs to the excluded 700-series range.

    Args:
        route_id: Raw route identifier to inspect.

    Returns:
        `True` for numeric routes between 700 and 799 inclusive.
    """
    text = normalize_route_id(route_id)
    if not text.isdigit():
        return False
    value = int(text)
    return 700 <= value <= 799


def active_routes_from_geometry(geom_dir: Union[Path, str] = DEFAULT_GEOM_DIR) -> Set[str]:
    """List active route ids by scanning processed geometry files.

    Args:
        geom_dir: Directory containing per-route GeoJSON files.

    Returns:
        A set of normalised active route ids, excluding known special cases.

    Side effects:
        Reads file names from the processed geometry directory.
    """
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
    """Fold a missing night variant back to its daytime route where appropriate.

    Args:
        route_id: Raw route identifier from upstream data.
        active_routes: Active route ids derived from processed geometry.

    Returns:
        The original route id, or the daytime equivalent when the night variant
        is absent from geometry but the daytime route is present.

    Side effects:
        Emits a debug log entry when a reconciliation occurs.
    """
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
