from __future__ import annotations

import json
from pathlib import Path

from scripts.fetch_bus_stops import stoppoints_payload_to_features
from tests.utils_geojson import assert_feature


def test_stoppoints_payload_to_features_filters_non_bus():
    payload_path = Path(__file__).parent / "fixtures" / "tfl" / "stoppoints_page1.json"
    payload = json.loads(payload_path.read_text(encoding="utf-8"))

    features = stoppoints_payload_to_features(payload)
    assert isinstance(features, list)
    assert len(features) == 1

    feature = features[0]
    assert_feature(feature)
    props = feature["properties"]
    assert props.get("NAPTAN_ID") == "490000123A"
    assert props.get("NAME") == "Alpha Stop"
    assert props.get("POSTCODE") == "SW1A 1AA"
    assert props.get("ROUTES") == "11, N11"
