"""Unit tests for semantic route geometry change detection."""
from scripts.changes import normalise_route_geometry


def route_payload(source_date: str, coordinates: list) -> dict:
    return {
        "metadata": {"routeId": "10", "sourceDate": source_date},
        "features": [
            {
                "properties": {
                    "routeId": "10",
                    "direction": "outbound",
                    "sourceDate": source_date,
                },
                "geometry": {"type": "LineString", "coordinates": coordinates},
            }
        ],
    }


def test_normalise_route_geometry_ignores_refresh_dates() -> None:
    old = route_payload("20260614", [[-0.1, 51.5], [-0.2, 51.6]])
    new = route_payload("20260621", [[-0.1, 51.5], [-0.2, 51.6]])

    assert normalise_route_geometry(old) == normalise_route_geometry(new)


def test_normalise_route_geometry_detects_coordinate_change() -> None:
    old = route_payload("20260614", [[-0.1, 51.5], [-0.2, 51.6]])
    new = route_payload("20260621", [[-0.1, 51.5], [-0.21, 51.6]])

    assert normalise_route_geometry(old) != normalise_route_geometry(new)


def test_normalise_route_geometry_ignores_multiline_segment_order() -> None:
    first_segment = [[-0.1, 51.5], [-0.2, 51.6]]
    second_segment = [[-0.3, 51.7], [-0.4, 51.8]]
    old = {
        "features": [
            {
                "properties": {"direction": "outbound", "sourceDate": "20260614"},
                "geometry": {"type": "MultiLineString", "coordinates": [first_segment, second_segment]},
            }
        ]
    }
    new = {
        "features": [
            {
                "properties": {"direction": "outbound", "sourceDate": "20260621"},
                "geometry": {"type": "MultiLineString", "coordinates": [second_segment, first_segment]},
            }
        ]
    }

    assert normalise_route_geometry(old) == normalise_route_geometry(new)
