"""Unit tests for route destination record selection and fallback rules."""
from scripts.fetch_route_destinations import build_route_destination_record


def test_build_route_destination_record_prefers_vehicle_destination_text() -> None:
    payloads = [
        [
            {
                "lineId": "24",
                "direction": "outbound",
                "vehicleDestinationText": "Hampstead Heath",
                "destinationName": "Royal Free Hospital",
                "isActive": True,
            },
            {
                "lineId": "24",
                "direction": "inbound",
                "vehicleDestinationText": "Pimlico",
                "destinationName": "Grosvenor Road",
                "isActive": True,
            },
        ]
    ]

    record = build_route_destination_record("24", payloads, ["Regular"])

    assert record is not None
    assert record["outbound"]["destination"] == "Hampstead Heath"
    assert record["outbound"]["qualifier"] == "Royal Free Hospital"
    assert record["inbound"]["destination"] == "Pimlico"
    assert record["inbound"]["qualifier"] == "Grosvenor Road"


def test_build_route_destination_record_falls_back_only_when_primary_missing_everywhere() -> None:
    payloads = [
        [
            {
                "lineId": "SL11",
                "direction": "outbound",
                "vehicleDestinationText": "",
                "destinationName": "Gayton Road / Abbey Wood Station",
                "isActive": True,
            },
            {
                "lineId": "SL11",
                "direction": "inbound",
                "vehicleDestinationText": None,
                "destinationName": "North Greenwich Station",
                "isActive": True,
            },
        ]
    ]

    record = build_route_destination_record("SL11", payloads, ["Regular"])

    assert record is not None
    assert record["outbound"]["destination"] == "Gayton Road / Abbey Wood Station"
    assert record["outbound"]["qualifier"] == ""
    assert record["inbound"]["destination"] == "North Greenwich Station"
    assert record["inbound"]["qualifier"] == ""


def test_build_route_destination_record_rejects_stale_destination_text_not_in_route_context() -> None:
    payloads = [
        [
            {
                "lineId": "C3",
                "direction": "inbound",
                "vehicleDestinationText": "Fulham, Sands End",
                "destinationName": "Clapham Junction Stn / the Falcon",
                "isActive": True,
            }
        ]
    ]
    route_contexts = {
        "inbound": {
            "destination_name": "Clapham Junction Stn / the Falcon",
            "origination_name": "West Cromwell Road",
            "intermediate_stop_names": ["Fulham Town Hall", "Sands End / Sainsbury's"],
            "final_approach_stop_names": ["Wallis Close", "Clapham Junction Station", "Clapham Junction Stn / the Falcon"],
            "final_approach_towards": ["Clapham Junction", "Vauxhall", "Battersea Bridge Or Vauxhall"],
            "route_section_name": "West Cromwell Road - Clapham Junction Stn / the Falcon",
        }
    }

    record = build_route_destination_record("C3", payloads, ["Regular"], route_contexts)

    assert record is not None
    assert record["inbound"]["destination"] == "Clapham Junction"
    assert record["inbound"]["qualifier"] == "Clapham Junction Stn / the Falcon"
    assert record["inbound"]["full"] == "Clapham Junction"


def test_build_route_destination_record_rejects_short_text_missing_from_final_approach() -> None:
    payloads = [
        [
            {
                "lineId": "X1",
                "direction": "outbound",
                "vehicleDestinationText": "Old Square",
                "destinationName": "New Street / New Town",
                "isActive": True,
            }
        ]
    ]
    route_contexts = {
        "outbound": {
            "destination_name": "New Street / New Town",
            "origination_name": "South Road",
            "intermediate_stop_names": ["Old Square"],
            "final_approach_stop_names": ["Central Avenue", "New Town Station", "New Street / New Town"],
            "final_approach_towards": ["New Town", "New Town", ""],
            "route_sequence_token_counts": {
                "old": 1,
                "square": 4,
                "new": 4,
                "town": 3,
            },
            "route_section_name": "South Road - New Street / New Town",
        }
    }

    record = build_route_destination_record("X1", payloads, ["Regular"], route_contexts)

    assert record is not None
    assert record["outbound"]["destination"] == "New Town"
    assert record["outbound"]["qualifier"] == "New Street / New Town"


def test_build_route_destination_record_keeps_valid_public_destination_text_with_terminal_overlap() -> None:
    payloads = [
        [
            {
                "lineId": "C3",
                "direction": "outbound",
                "vehicleDestinationText": "Earl's Court, Tesco",
                "destinationName": "Warwick Road Tesco",
                "isActive": True,
            }
        ]
    ]
    route_contexts = {
        "outbound": {
            "destination_name": "Warwick Road Tesco",
            "origination_name": "Clapham Junction Station / Falcon Road",
            "final_approach_stop_names": ["Earls Court Station", "Warwick Road Tesco"],
            "final_approach_towards": ["Kensington or Gloucester Road", ""],
            "route_section_name": "Clapham Junction Station / Falcon Road - Warwick Road Tesco",
        }
    }

    record = build_route_destination_record("C3", payloads, ["Regular"], route_contexts)

    assert record is not None
    assert record["outbound"]["destination"] == "Earl's Court, Tesco"
    assert record["outbound"]["qualifier"] == "Warwick Road Tesco"


def test_build_route_destination_record_keeps_public_destination_without_stronger_conflict() -> None:
    payloads = [
        [
            {
                "lineId": "24",
                "direction": "outbound",
                "vehicleDestinationText": "Hampstead Heath",
                "destinationName": "South End Green",
                "isActive": True,
            }
        ]
    ]
    route_contexts = {
        "outbound": {
            "destination_name": "South End Green",
            "origination_name": "Grosvenor Road",
            "intermediate_stop_names": ["Camden Town Station", "Mornington Crescent"],
            "final_approach_stop_names": ["Queen's Crescent", "Mansfield Road", "Royal Free Hospital"],
            "final_approach_towards": ["Hampstead Heath", "Hampstead Heath", ""],
            "route_section_name": "Grosvenor Road - South End Green",
        }
    }

    record = build_route_destination_record("24", payloads, ["Regular"], route_contexts)

    assert record is not None
    assert record["outbound"]["destination"] == "Hampstead Heath"
    assert record["outbound"]["qualifier"] == "South End Green"
