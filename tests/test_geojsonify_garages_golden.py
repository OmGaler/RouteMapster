"""Golden-file tests for the garage CSV to GeoJSON conversion pipeline."""
from __future__ import annotations

import json
from pathlib import Path

from scripts.geojsonify_garages import garages_csv_to_features, features_to_feature_collection


FIXTURES_DIR = Path(__file__).parent / "fixtures" / "garages"


def _garage_geocode_stub(postcode: str):
    """Return deterministic coordinates for the fixture postcodes used in this test."""
    mapping = {
        "E8 4RH": (-0.055, 51.546, "E8 4RH"),
        "SW1A 1AA": (-0.141, 51.501, "SW1A 1AA"),
    }
    return mapping.get(postcode)


def _sort_features(fc: dict) -> dict:
    def key(feature: dict):
        props = feature.get("properties", {})
        return (props.get("TfL garage code") or "", props.get("Garage name") or "")

    return {
        "type": fc.get("type"),
        "features": sorted(fc.get("features", []), key=key),
    }


def test_garages_geojson_matches_expected():
    csv_text = (FIXTURES_DIR / "garages_sample.csv").read_text(encoding="utf-8")
    expected = json.loads((FIXTURES_DIR / "garages_sample_expected.geojson").read_text(encoding="utf-8"))

    features = garages_csv_to_features(csv_text, _garage_geocode_stub)
    actual = features_to_feature_collection(features)

    assert _sort_features(actual) == _sort_features(expected)
