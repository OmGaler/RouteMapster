"""Unit tests for shared route identifier normalisation rules."""
from __future__ import annotations

import logging

from scripts.geojsonify_garages import apply_route_fixes_to_rows, parse_routes
from scripts.utils.route_ids import normalize_route_id, reconcile_possible_ghost_night_route


def test_normalize_route_id_uppercases_and_trims() -> None:
    assert normalize_route_id(" n13 ") == "N13"
    assert normalize_route_id("sl10") == "SL10"
    assert normalize_route_id(None) == ""


def test_reconcile_ghost_night_route_folds_when_day_active(caplog) -> None:
    active_routes = {"13"}
    with caplog.at_level(logging.DEBUG):
        resolved = reconcile_possible_ghost_night_route("N13", active_routes)
    assert resolved == "13"
    assert any(
        "Reconciled ghost night route N13 -> 13 (N13 not active; 13 active)" in record.message
        for record in caplog.records
    )


def test_reconcile_keeps_real_night_route_when_active() -> None:
    active_routes = {"N113"}
    assert reconcile_possible_ghost_night_route("N113", active_routes) == "N113"


def test_reconcile_only_folds_when_day_active() -> None:
    active_routes = set()
    assert reconcile_possible_ghost_night_route("N550", active_routes) == "N550"
    assert reconcile_possible_ghost_night_route("N551", active_routes) == "N551"
    assert reconcile_possible_ghost_night_route("N118", active_routes) == "N118"


def test_night_routes_do_not_infer_day_routes_in_garages() -> None:
    rows = [
        {
            "TfL main network routes": "",
            "TfL night routes": "N550 N551 N118",
            "TfL school/mobility routes": "",
            "Other routes": "",
        }
    ]
    apply_route_fixes_to_rows(rows)
    main_routes = set(parse_routes(rows[0]["TfL main network routes"]))
    night_routes = set(parse_routes(rows[0]["TfL night routes"]))

    assert "550" not in main_routes
    assert "551" not in main_routes
    assert "118" not in main_routes
    assert {"N550", "N551", "N118"} <= night_routes
