from __future__ import annotations

import math

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
