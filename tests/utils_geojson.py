"""
Shared GeoJSON assertions used by multiple Python test modules.

These helpers keep fixture validation consistent and make failures easier to
interpret than repeated inline structural assertions.
"""
from __future__ import annotations

from typing import Any


ALLOWED_GEOM_TYPES = {"Point", "LineString", "MultiLineString", "Polygon", "MultiPolygon"}


def _is_number(value: Any) -> bool:
    """Return whether a value is a real numeric coordinate token."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _assert_numeric_coords(coords: Any) -> None:
    """Recursively assert that a nested coordinate structure is numeric."""
    if isinstance(coords, (list, tuple)):
        for item in coords:
            _assert_numeric_coords(item)
        return
    assert _is_number(coords), f"Non-numeric coordinate: {coords!r}"


def assert_geometry(geom: dict) -> None:
    """Assert the minimal structure and coordinate validity of a GeoJSON geometry."""
    assert isinstance(geom, dict), "Geometry must be a dict"
    gtype = geom.get("type")
    assert gtype in ALLOWED_GEOM_TYPES, f"Unexpected geometry type: {gtype!r}"
    coords = geom.get("coordinates")
    assert coords is not None, "Geometry missing coordinates"

    if gtype == "Point":
        assert isinstance(coords, (list, tuple)), "Point coordinates must be a list"
        assert len(coords) >= 2, "Point must have at least [lon, lat]"
        lon, lat = coords[0], coords[1]
        assert _is_number(lon) and _is_number(lat), "Point coordinates must be numeric"
        assert -180.0 <= float(lon) <= 180.0, f"Longitude out of range: {lon!r}"
        assert -90.0 <= float(lat) <= 90.0, f"Latitude out of range: {lat!r}"
    else:
        _assert_numeric_coords(coords)


def assert_feature(feature: dict) -> None:
    """Assert that a GeoJSON feature has the expected wrapper structure."""
    assert isinstance(feature, dict), "Feature must be a dict"
    assert feature.get("type") == "Feature", "Feature type must be 'Feature'"
    assert "geometry" in feature, "Feature missing geometry"
    assert "properties" in feature, "Feature missing properties"
    assert isinstance(feature["properties"], dict), "Feature properties must be a dict"
    assert_geometry(feature["geometry"])


def assert_feature_collection(fc: dict) -> None:
    """Assert that a GeoJSON FeatureCollection only contains valid features."""
    assert isinstance(fc, dict), "FeatureCollection must be a dict"
    assert fc.get("type") == "FeatureCollection", "FeatureCollection type must be 'FeatureCollection'"
    features = fc.get("features")
    assert isinstance(features, list), "FeatureCollection features must be a list"
    for feature in features:
        assert_feature(feature)
