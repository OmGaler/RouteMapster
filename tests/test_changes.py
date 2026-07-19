"""Unit tests for processed data change summaries."""
from scripts.changes import (
    build_destination_changes,
    build_destination_refresh_routes,
    route_terminal_signature,
)


def test_destination_refresh_routes_include_only_new_or_geometry_updated_routes() -> None:
    assert build_destination_refresh_routes(["10", "20"], ["20", "30"]) == ["10", "20", "30"]


def test_build_destination_changes_reports_directional_destination_updates() -> None:
    old = {
        "routes": {
            "10": {
                "outbound": {"destination": "Old North Terminal"},
                "inbound": {"destination": "South Terminal"},
            },
            "20": {
                "outbound": {"destination": "East Station"},
                "inbound": {"destination": "Old West Stand"},
            },
        }
    }
    new = {
        "routes": {
            "10": {
                "outbound": {"destination": "New North Terminal"},
                "inbound": {"destination": "South Terminal"},
            },
            "20": {
                "outbound": {"destination": "East Station"},
                "inbound": {"destination": "New West Stand"},
            },
        }
    }

    assert build_destination_changes(old, new) == [
        "10 outbound destination changed from Old North Terminal to New North Terminal",
        "20 inbound destination changed from Old West Stand to New West Stand",
    ]


def test_route_terminal_signature_ignores_metadata_and_duplicate_variants() -> None:
    old = {
        "features": [
            {
                "properties": {"direction": "1", "sourceDate": "20260703"},
                "geometry": {"type": "LineString", "coordinates": [[-0.1, 51.5], [-0.2, 51.6]]},
            }
        ]
    }
    new = {
        "features": [
            {
                "properties": {"direction": "1", "sourceDate": "20260717"},
                "geometry": {
                    "type": "MultiLineString",
                    "coordinates": [
                        [[-0.10002, 51.50001], [-0.2, 51.6]],
                        [[-0.1, 51.5], [-0.2, 51.6]],
                    ],
                },
            }
        ]
    }

    assert route_terminal_signature(old) == route_terminal_signature(new)


def test_route_terminal_signature_detects_a_changed_terminus() -> None:
    old = {"features": [{"properties": {"direction": "1"}, "geometry": {"type": "LineString", "coordinates": [[-0.1, 51.5], [-0.2, 51.6]]}}]}
    new = {"features": [{"properties": {"direction": "1"}, "geometry": {"type": "LineString", "coordinates": [[-0.1, 51.5], [-0.3, 51.6]]}}]}

    assert route_terminal_signature(old) != route_terminal_signature(new)
