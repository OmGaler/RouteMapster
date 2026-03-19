"""
Unit tests for the route summary helper module.

The cases here focus on route token parsing, route ordering, geometry length
aggregation, and cached destination enrichment.
"""
from __future__ import annotations

import json
import math
import shutil
from pathlib import Path
from uuid import uuid4

from scripts.utils import route_summary as rs


def test_parse_route_tokens_filters_and_normalizes() -> None:
    value = " 1, n5; 700 /UL3 T2 scs; 12- x1 "
    assert rs.parse_route_tokens(value) == ["1", "N5", "12", "X1"]


def test_build_route_sets_handles_tram_and_overlaps() -> None:
    features = [
        {
            "properties": {
                "TfL main network routes": "1 N2",
                "TfL night routes": "N5 15",
                "TfL school/mobility routes": "1 3",
                "Other routes": "X1",
            }
        },
        {
            "properties": {
                "Company name": "Tramlink",
                "TfL main network routes": "99",
                "TfL night routes": "N99",
            }
        },
    ]

    route_sets = rs.build_route_sets(features)
    assert route_sets["regular"] == {"1", "N2"}
    assert route_sets["night"] == {"N5"}
    assert route_sets["twentyfour"] == {"15"}
    assert route_sets["other"] == {"X1"}
    assert route_sets["school"] == {"3"}
    assert route_sets["school_overlaps"] == {"1"}
    for bucket in ("regular", "night", "school", "other", "twentyfour"):
        assert "99" not in route_sets[bucket]
        assert "N99" not in route_sets[bucket]


def test_route_sort_key_orders_expected() -> None:
    routes = ["N5", "15", "700", "D3", "SL1", "601", "T2", "X", "123A"]
    expected = ["15", "601", "700", "D3", "T2", "X", "SL1", "N5", "123A"]
    assert sorted(routes, key=rs.route_sort_key) == expected


def test_geometry_length_and_route_length_aggregation() -> None:
    short_segment = [[0.0, 0.0], [0.0, 0.5]]
    long_segment = [[0.0, 0.0], [0.0, 1.0], [0.0, 2.0]]
    short_len = rs.line_length_km(short_segment)
    long_len = rs.line_length_km(long_segment)

    geom = {"type": "MultiLineString", "coordinates": [short_segment, long_segment]}
    assert math.isclose(rs.geometry_length_km(geom), long_len, rel_tol=1e-6)

    route_geojson = {
        "features": [
            {"geometry": {"type": "LineString", "coordinates": short_segment}},
            {"geometry": {"type": "LineString", "coordinates": long_segment}},
            {"geometry": {"type": "Point", "coordinates": [0.0, 0.0]}},
        ]
    }
    mean_expected = (short_len + long_len) / 2
    length = rs.route_length_km(route_geojson)
    assert length is not None
    assert math.isclose(length, mean_expected, rel_tol=1e-6)


def _local_temp_dir() -> Path:
    """Create an isolated temporary directory under the local pytest scratch area."""
    root = Path(".pytest_local_tmp")
    root.mkdir(exist_ok=True)
    path = root / f"route-summary-{uuid4().hex}"
    path.mkdir()
    return path


def test_load_route_destinations_map_reads_cached_destinations() -> None:
    temp_dir = _local_temp_dir()
    try:
        path = temp_dir / "route_destinations.json"
        path.write_text(
            json.dumps(
                {
                    "generated_at_utc": "2026-03-13T00:00:00Z",
                    "routes": {
                        "24": {
                            "outbound": {
                                "destination": "Hampstead Heath",
                                "qualifier": "Royal Free Hospital",
                                "full": "Hampstead Heath, Royal Free Hospital",
                            },
                            "inbound": {
                                "destination": "Pimlico",
                                "qualifier": "Grosvenor Road",
                                "full": "Pimlico, Grosvenor Road",
                            },
                        }
                    },
                }
            ),
            encoding="utf-8",
        )

        loaded = rs.load_route_destinations_map(path)

        assert loaded["24"]["destination_outbound"] == "Hampstead Heath"
        assert loaded["24"]["destination_inbound"] == "Pimlico"
        assert loaded["24"]["destination_outbound_qualifier"] == "Royal Free Hospital"
        assert loaded["24"]["destination_inbound_qualifier"] == "Grosvenor Road"
        assert loaded["24"]["destination_outbound_full"] == "Hampstead Heath, Royal Free Hospital"
        assert loaded["24"]["destination_inbound_full"] == "Pimlico, Grosvenor Road"
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_build_route_summary_rows_includes_cached_destinations() -> None:
    temp_path = _local_temp_dir()
    try:
        garages_path = temp_path / "garages.geojson"
        frequencies_path = temp_path / "frequencies.json"
        routes_dir = temp_path / "routes"
        routes_index_path = temp_path / "index.json"
        vehicles_path = temp_path / "vehicles.json"
        destinations_path = temp_path / "route_destinations.json"

        garages_path.write_text(json.dumps({"features": []}), encoding="utf-8")
        frequencies_path.write_text(json.dumps({}), encoding="utf-8")
        routes_dir.mkdir()
        routes_index_path.write_text(json.dumps({"routes": ["24"]}), encoding="utf-8")
        vehicles_path.write_text(json.dumps({}), encoding="utf-8")
        destinations_path.write_text(
            json.dumps(
                {
                    "routes": {
                        "24": {
                            "outbound": {
                                "destination": "Hampstead Heath",
                                "qualifier": "Royal Free Hospital",
                                "full": "Hampstead Heath, Royal Free Hospital",
                            },
                            "inbound": {
                                "destination": "Pimlico",
                                "qualifier": "Grosvenor Road",
                                "full": "Pimlico, Grosvenor Road",
                            },
                        }
                    }
                }
            ),
            encoding="utf-8",
        )

        rows = rs.build_route_summary_rows(
            garages_path,
            frequencies_path,
            routes_dir,
            routes_index_path,
            vehicles_path,
            destinations_path,
            include_length=False,
        )

        assert len(rows) == 1
        row = rows[0]
        assert row["route"] == "24"
        assert row["destination_outbound"] == "Hampstead Heath"
        assert row["destination_inbound"] == "Pimlico"
        assert row["destination_outbound_qualifier"] == "Royal Free Hospital"
        assert row["destination_inbound_qualifier"] == "Grosvenor Road"
    finally:
        shutil.rmtree(temp_path, ignore_errors=True)
