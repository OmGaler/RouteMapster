"""
GeoJSON invariant tests for generated stop and garage fixtures.

These tests prove that the pipeline produces structurally valid GeoJSON before
the data is consumed by the browser application.
"""
from __future__ import annotations

import json
from pathlib import Path

from scripts.fetch_bus_stops import stoppoints_payload_to_features
from scripts.geojsonify_garages import garages_csv_to_features, features_to_feature_collection
from tests.utils_geojson import assert_feature_collection


FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _garage_geocode_stub(postcode: str):
    """Return deterministic coordinates for fixture postcode lookups."""
    mapping = {
        "E8 4RH": (-0.055, 51.546, "E8 4RH"),
        "SW1A 1AA": (-0.141, 51.501, "SW1A 1AA"),
    }
    return mapping.get(postcode)


def test_expected_fixtures_are_valid_geojson():
    garages_expected = FIXTURES_DIR / "garages" / "garages_sample_expected.geojson"
    data = json.loads(garages_expected.read_text(encoding="utf-8"))
    assert_feature_collection(data)


def test_generated_garages_geojson_invariants():
    csv_path = FIXTURES_DIR / "garages" / "garages_sample.csv"
    csv_text = csv_path.read_text(encoding="utf-8")
    features = garages_csv_to_features(csv_text, _garage_geocode_stub)
    fc = features_to_feature_collection(features)
    assert_feature_collection(fc)


def test_generated_stoppoints_geojson_invariants():
    payload_path = FIXTURES_DIR / "tfl" / "stoppoints_page1.json"
    payload = json.loads(payload_path.read_text(encoding="utf-8"))
    features = stoppoints_payload_to_features(payload)
    fc = features_to_feature_collection(features)
    assert_feature_collection(fc)
