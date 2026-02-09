from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload: Any, *, sort_keys: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=True, separators=(",", ":"), sort_keys=sort_keys)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def extract_stop_id(props: Dict[str, Any]) -> Optional[str]:
    for key in ("PLACE_ID", "place_id", "NAPTAN_ID", "naptanId", "stopPointId", "stop_id", "stopId", "id"):
        value = props.get(key)
        if value:
            return str(value).strip()
    return None


def extract_stop_name(props: Dict[str, Any]) -> Optional[str]:
    for key in ("NAME", "name", "display_name", "stopName"):
        value = props.get(key)
        if value:
            return str(value).strip()
    return None


def slugify(text: str) -> str:
    cleaned = []
    prev_underscore = False
    for ch in text.strip().lower():
        if ch.isalnum():
            cleaned.append(ch)
            prev_underscore = False
        else:
            if not prev_underscore:
                cleaned.append("_")
                prev_underscore = True
    slug = "".join(cleaned).strip("_")
    return slug or "unknown"


def fingerprint_file(path: Optional[Path]) -> Optional[Dict[str, Any]]:
    if path is None or not path.exists():
        return None
    stat = path.stat()
    return {"mtime": stat.st_mtime, "size": stat.st_size}


def iter_json_lines(path: Path) -> Iterable[Dict[str, Any]]:
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            yield json.loads(line)
