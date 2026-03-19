#!/usr/bin/env python3
"""
Fetch ordered stop sequences for each route from the TfL API.

This script builds a cache of route-stop ordering that downstream processing
and diagnostics can reuse without repeatedly calling the live API.
"""
from __future__ import annotations

import argparse
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

try:
    from scripts.utils.route_ids import normalize_route_id
except ModuleNotFoundError:  # pragma: no cover - script execution fallback
    from utils.route_ids import normalize_route_id


BASE_URL = "https://api.tfl.gov.uk"


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def write_jsonl(path: Path, rows: Sequence[Dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=True, separators=(",", ":"), sort_keys=True))
            handle.write("\n")


def read_jsonl(path: Path) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def load_dotenv(path: str = ".env") -> None:
    p = (repo_root() / path) if not Path(path).is_absolute() else Path(path)
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


def require_env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        raise SystemExit(f"Missing {name}. Set it in your environment or .env.")
    return v


def make_session() -> requests.Session:
    session = requests.Session()
    retry = Retry(
        total=6,
        backoff_factor=0.8,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET",),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=10, pool_maxsize=10)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def normalize_routes(routes: Iterable[str]) -> List[str]:
    output: List[str] = []
    seen = set()
    for route in routes:
        norm = normalize_route_id(route)
        if not norm:
            continue
        if norm in seen:
            continue
        seen.add(norm)
        output.append(norm)
    return output


def load_routes_from_index(path: Path) -> List[str]:
    if not path.exists():
        return []
    payload = load_json(path)
    routes = payload.get("routes") if isinstance(payload, dict) else None
    if not isinstance(routes, list):
        return []
    return normalize_routes([str(r) for r in routes])


def extract_stop_ids(stop_points: Any) -> List[str]:
    if not isinstance(stop_points, list):
        return []
    ids: List[str] = []
    prev = None
    for item in stop_points:
        stop_id: Optional[str] = None
        if isinstance(item, str):
            stop_id = item
        elif isinstance(item, dict):
            stop_id = item.get("id") or item.get("naptanId") or item.get("stopPointId")
        if stop_id:
            stop_id = str(stop_id).strip()
        if not stop_id or stop_id == prev:
            continue
        ids.append(stop_id)
        prev = stop_id
    return ids


@dataclass
class SequenceRecord:
    """One directional route sequence record ready for JSON serialisation."""
    route_id: str
    direction: str
    service_type: Optional[str]
    name: Optional[str]
    sequence_index: int
    stops: List[str]

    def to_json(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "route_id": self.route_id,
            "direction": self.direction,
            "sequence_index": self.sequence_index,
            "stops": self.stops,
        }
        if self.service_type:
            payload["service_type"] = self.service_type
        if self.name:
            payload["name"] = self.name
        return payload


def fetch_route_sequence(
    session: requests.Session,
    route_id: str,
    direction: str,
    service_types: Sequence[str],
    app_key: str,
    app_id: Optional[str],
    exclude_crowding: bool,
) -> Dict[str, Any]:
    url = f"{BASE_URL}/Line/{route_id}/Route/Sequence/{direction}"
    params: Dict[str, Any] = {
        "serviceTypes": ",".join(service_types),
        "excludeCrowding": str(exclude_crowding).lower(),
        "app_key": app_key,
    }
    if app_id:
        params["app_id"] = app_id
    resp = session.get(url, params=params, timeout=(10.0, 60.0))
    if resp.status_code >= 400:
        raise requests.HTTPError(f"{resp.status_code} {resp.url}\n{resp.text[:300]}", response=resp)
    return resp.json()


def build_records(payload: Dict[str, Any], fallback_route: str, fallback_direction: str) -> List[SequenceRecord]:
    """Convert a TfL route sequence payload into cacheable records.

    Args:
        payload: Raw route sequence payload from the TfL API.
        fallback_route: Route id to use when the payload omits one.
        fallback_direction: Direction to use when the payload omits one.

    Returns:
        Sequence records containing ordered stop ids for each usable sequence.
    """
    records: List[SequenceRecord] = []
    stop_sequences = payload.get("stopPointSequences")
    if not isinstance(stop_sequences, list):
        return records
    for idx, seq in enumerate(stop_sequences):
        if not isinstance(seq, dict):
            continue
        route_id = normalize_route_id(str(seq.get("lineId") or payload.get("lineId") or fallback_route))
        direction = str(seq.get("direction") or payload.get("direction") or fallback_direction)
        service_type = seq.get("serviceType") or payload.get("serviceType")
        name = seq.get("name")
        stops = extract_stop_ids(seq.get("stopPoint"))
        if route_id and direction and len(stops) > 1:
            records.append(
                SequenceRecord(
                    route_id=route_id,
                    direction=direction,
                    service_type=service_type,
                    name=name,
                    sequence_index=idx,
                    stops=stops,
                )
            )
    return records


def main() -> int:
    """Fetch route stop sequences and refresh the cached sequence outputs.

    Returns:
        Process exit code for CLI usage.

    Side effects:
        Calls the TfL API and writes JSON and JSONL cache files to disk.
    """
    parser = argparse.ArgumentParser(description="Fetch TfL route stop sequences.")
    parser.add_argument("--routes-index", default=str(repo_root() / "data" / "processed" / "routes" / "index.json"))
    parser.add_argument("--line-ids", help="Comma-separated list of line ids to fetch.")
    parser.add_argument("--output", default=str(repo_root() / "data" / "processed" / "stop_analysis" / "route_sequences.jsonl"))
    parser.add_argument("--meta-output", default=str(repo_root() / "data" / "processed" / "stop_analysis" / "route_sequences_meta.json"))
    parser.add_argument("--direction", choices=["inbound", "outbound", "all"], default="all")
    parser.add_argument("--service-types", nargs="*", default=["Regular", "Night"])
    parser.add_argument("--exclude-crowding", action="store_true", default=True)
    parser.add_argument("--no-exclude-crowding", action="store_false", dest="exclude_crowding")
    parser.add_argument("--sleep", type=float, default=0.05)
    parser.add_argument("--max-lines", type=int)
    parser.add_argument("--replace-existing", action="store_true", default=False)
    parser.add_argument("--drop-routes", help="Comma-separated list of routes to remove from output.")
    parser.add_argument("--resume", action="store_true", default=True)
    parser.add_argument("--no-resume", action="store_false", dest="resume")
    parser.add_argument("--no-index", action="store_true", help="Skip routes index fallback if --line-ids is empty.")
    args = parser.parse_args()

    load_dotenv()
    app_key = require_env("TFL_APP_KEY")
    app_id = os.environ.get("TFL_APP_ID", "").strip() or None

    routes: List[str] = []
    if args.line_ids is not None:
        routes = normalize_routes([r.strip() for r in args.line_ids.split(",") if r.strip()])
    elif not args.no_index:
        routes = load_routes_from_index(Path(args.routes_index))

    if not routes and not args.no_index:
        raise SystemExit("No routes to fetch. Provide --line-ids or ensure routes index exists.")

    if args.max_lines is not None:
        routes = routes[: args.max_lines]

    output_path = Path(args.output)
    meta_path = Path(args.meta_output)

    session = make_session()
    records: List[SequenceRecord] = []
    existing_rows: List[Dict[str, Any]] = []
    existing_routes: set[str] = set()
    drop_routes = normalize_routes([r.strip() for r in (args.drop_routes or "").split(",") if r.strip()])
    if output_path.exists() and args.resume:
        existing_rows = read_jsonl(output_path)
        if args.replace_existing and routes:
            replace_set = set(routes)
            existing_rows = [row for row in existing_rows if row.get("route_id") not in replace_set]
        if drop_routes:
            drop_set = set(drop_routes)
            existing_rows = [row for row in existing_rows if row.get("route_id") not in drop_set]
        for row in existing_rows:
            route_id = row.get("route_id")
            if route_id:
                existing_routes.add(str(route_id))
    errors: List[str] = []

    for idx, route_id in enumerate(routes, start=1):
        if args.resume and not args.replace_existing and route_id in existing_routes:
            continue
        try:
            payload = fetch_route_sequence(
                session,
                route_id=route_id,
                direction=args.direction,
                service_types=args.service_types,
                app_key=app_key,
                app_id=app_id,
                exclude_crowding=args.exclude_crowding,
            )
            records.extend(build_records(payload, fallback_route=route_id, fallback_direction=args.direction))
        except requests.HTTPError as exc:
            errors.append(f"{route_id}: {exc}")
        except Exception as exc:  # pragma: no cover - defensive for live calls
            errors.append(f"{route_id}: {exc}")

        if args.sleep:
            time.sleep(args.sleep)
        if idx % 25 == 0:
            print(f"[{idx}/{len(routes)}] fetched")

    records_sorted = sorted(
        records,
        key=lambda r: (r.route_id, r.direction, r.service_type or "", r.sequence_index),
    )
    rows = existing_rows + [r.to_json() for r in records_sorted]
    rows = sorted(
        rows,
        key=lambda r: (
            r.get("route_id", ""),
            r.get("direction", ""),
            r.get("service_type", "") or "",
            r.get("sequence_index", 0),
        ),
    )

    write_jsonl(output_path, rows)

    meta = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "route_count": len(routes),
        "sequence_count": len(rows),
        "direction": args.direction,
        "service_types": args.service_types,
        "routes_index": str(Path(args.routes_index)),
        "resume": args.resume,
        "replace_existing": args.replace_existing,
        "drop_routes": drop_routes,
        "no_index": args.no_index,
        "skipped_routes": len(existing_routes),
        "errors": errors,
    }
    write_json(meta_path, meta)

    print(f"Wrote {len(records_sorted)} sequences to {output_path}")
    if errors:
        print(f"Errors: {len(errors)} (see meta file)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
