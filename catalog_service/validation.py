"""Validation for catalog payloads.

Only the outer schema is validated.  Workflow nodes and extension fields are
preserved byte-for-byte (after JSON parsing); workflows are never executed and
no ComfyUI compatibility claim is made.
"""

from __future__ import annotations

import json
import re

from .config import (
    MAX_CATEGORY_CHARS,
    MAX_DESCRIPTION_CHARS,
    MAX_IMPORT_ITEMS,
    MAX_NAME_CHARS,
    MAX_TEXT_BYTES,
    MAX_WORKFLOW_BYTES,
)

KINDS = ("template", "preset", "snippet")
STATUSES = ("draft", "published", "disabled")
TEMPLATE_KEYS = frozenset({"schemaVersion", "workflow", "defaults", "editor"})
PRESET_KEYS = frozenset({"positive", "negative"})
SNIPPET_KEYS = frozenset({"text", "target"})
SNIPPET_TARGETS = ("positive", "negative")
CREATE_KEYS = frozenset({"kind", "name", "description", "category", "order", "data"})
PATCH_KEYS = frozenset({"name", "description", "category", "order", "data", "baseRev"})

_SECRET_KEY_RE = re.compile(
    r"(api[_-]?key|apikey|access[_-]?key|token|secret|password|passwd|credential|authorization)",
    re.IGNORECASE,
)


class ValidationError(ValueError):
    """Invalid client input; the message is safe to return to the client."""


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _compact_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _json_bytes(value) -> int:
    return len(_compact_json(value).encode("utf-8"))


def _reject_unknown(mapping: dict, allowed, where: str) -> None:
    unknown = sorted(set(mapping) - set(allowed))
    if unknown:
        raise ValidationError(f"{where} contains unsupported fields: {', '.join(unknown)}")


def _require_text(value, field: str, max_bytes: int, *, allow_empty: bool = True) -> str:
    if not isinstance(value, str):
        raise ValidationError(f"{field} must be a string")
    if not allow_empty and not value.strip():
        raise ValidationError(f"{field} must not be blank")
    if "\x00" in value:
        raise ValidationError(f"{field} must not contain NUL bytes")
    if len(value.encode("utf-8")) > max_bytes:
        raise ValidationError(f"{field} exceeds {max_bytes} UTF-8 bytes")
    return value


def _validate_name(value) -> str:
    name = _require_text(value, "name", 4 * MAX_NAME_CHARS, allow_empty=False)
    if len(name) > MAX_NAME_CHARS:
        raise ValidationError(f"name must be at most {MAX_NAME_CHARS} characters")
    return name


def _validate_description(value) -> str:
    desc = _require_text(value, "description", 4 * MAX_DESCRIPTION_CHARS)
    if len(desc) > MAX_DESCRIPTION_CHARS:
        raise ValidationError(f"description must be at most {MAX_DESCRIPTION_CHARS} characters")
    return desc


def _validate_category(value) -> str:
    cat = _require_text(value, "category", 4 * MAX_CATEGORY_CHARS)
    if len(cat) > MAX_CATEGORY_CHARS:
        raise ValidationError(f"category must be at most {MAX_CATEGORY_CHARS} characters")
    return cat


def _validate_order(value) -> int:
    if not _is_int(value):
        raise ValidationError("order must be an integer")
    if abs(value) > 1_000_000:
        raise ValidationError("order out of range")
    return value


def validate_data(kind: str, data) -> dict:
    """Validate a payload for ``kind`` and return the normalized dict."""
    if kind not in KINDS:
        raise ValidationError(f"kind must be one of: {', '.join(KINDS)}")
    if not isinstance(data, dict):
        raise ValidationError("data must be an object")

    if kind == "template":
        _reject_unknown(data, TEMPLATE_KEYS, "template data")
        missing = sorted(TEMPLATE_KEYS - set(data))
        if missing:
            raise ValidationError(f"template data is missing fields: {', '.join(missing)}")
        if data["schemaVersion"] != 2 or not _is_int(data["schemaVersion"]):
            raise ValidationError("template schemaVersion must be 2")
        for field in ("workflow", "defaults", "editor"):
            if not isinstance(data[field], dict):
                raise ValidationError(f"template {field} must be an object")
        if _json_bytes(data["workflow"]) > MAX_WORKFLOW_BYTES:
            raise ValidationError(f"template workflow exceeds {MAX_WORKFLOW_BYTES} bytes")
        return {
            "schemaVersion": 2,
            "workflow": data["workflow"],
            "defaults": data["defaults"],
            "editor": data["editor"],
        }

    if kind == "preset":
        _reject_unknown(data, PRESET_KEYS, "preset data")
        missing = sorted(PRESET_KEYS - set(data))
        if missing:
            raise ValidationError(f"preset data is missing fields: {', '.join(missing)}")
        return {
            "positive": _require_text(data["positive"], "positive", MAX_TEXT_BYTES),
            "negative": _require_text(data["negative"], "negative", MAX_TEXT_BYTES),
        }

    _reject_unknown(data, SNIPPET_KEYS, "snippet data")
    missing = sorted(SNIPPET_KEYS - set(data))
    if missing:
        raise ValidationError(f"snippet data is missing fields: {', '.join(missing)}")
    target = data["target"]
    if target not in SNIPPET_TARGETS:
        raise ValidationError("snippet target must be 'positive' or 'negative'")
    return {
        "text": _require_text(data["text"], "text", MAX_TEXT_BYTES),
        "target": target,
    }


def validate_create(payload) -> dict:
    """Validate a create-shaped object (also used for seed/import items)."""
    if not isinstance(payload, dict):
        raise ValidationError("item must be an object")
    _reject_unknown(payload, CREATE_KEYS, "item")
    kind = payload.get("kind")
    if kind not in KINDS:
        raise ValidationError(f"kind must be one of: {', '.join(KINDS)}")
    if "name" not in payload:
        raise ValidationError("name is required")
    if "data" not in payload:
        raise ValidationError("data is required")
    return {
        "kind": kind,
        "name": _validate_name(payload["name"]),
        "description": _validate_description(payload.get("description", "")),
        "category": _validate_category(payload.get("category", "")),
        "order": _validate_order(payload.get("order", 0)),
        "data": validate_data(kind, payload["data"]),
    }


def validate_patch(payload, current_kind: str) -> dict:
    """Validate a PATCH body; returns only the fields that were supplied."""
    if not isinstance(payload, dict):
        raise ValidationError("body must be an object")
    _reject_unknown(payload, PATCH_KEYS, "patch")
    if "baseRev" not in payload:
        raise ValidationError("baseRev is required")
    if not _is_int(payload["baseRev"]):
        raise ValidationError("baseRev must be an integer")
    changes: dict = {"baseRev": payload["baseRev"]}
    if "name" in payload:
        changes["name"] = _validate_name(payload["name"])
    if "description" in payload:
        changes["description"] = _validate_description(payload["description"])
    if "category" in payload:
        changes["category"] = _validate_category(payload["category"])
    if "order" in payload:
        changes["order"] = _validate_order(payload["order"])
    if "data" in payload:
        changes["data"] = validate_data(current_kind, payload["data"])
    if len(changes) == 1:
        raise ValidationError("patch must change at least one field")
    return changes


def validate_import(payload) -> list[dict]:
    if not isinstance(payload, dict):
        raise ValidationError("body must be an object")
    _reject_unknown(payload, {"items"}, "import body")
    items = payload.get("items")
    if not isinstance(items, list):
        raise ValidationError("items must be a list")
    if not items:
        raise ValidationError("items must not be empty")
    if len(items) > MAX_IMPORT_ITEMS:
        raise ValidationError(f"at most {MAX_IMPORT_ITEMS} items can be imported at once")
    return [validate_create(item) for item in items]


def find_workflow_secret_paths(workflow, prefix: str = "workflow") -> list[str]:
    """Return dotted key paths whose key names look secret-bearing.

    Iterative with an explicit depth cap so arbitrarily nested workflows can
    never raise RecursionError (and therefore no 500).  Deeper structures are
    simply not inspected.  This is a best-effort publish gate only: it reports
    key names (never values) and makes no claim to detect secrets embedded in
    arbitrary text.
    """
    found: list[str] = []
    max_depth = 64
    stack = [(workflow, prefix, 0)]
    while stack:
        node, path, depth = stack.pop()
        if depth > max_depth:
            continue
        if isinstance(node, dict):
            for key, value in node.items():
                child = f"{path}.{key}" if path else str(key)
                if _SECRET_KEY_RE.search(str(key)):
                    if isinstance(value, str) and value.strip():
                        found.append(child)
                stack.append((value, child, depth + 1))
        elif isinstance(node, list):
            for index, value in enumerate(node):
                stack.append((value, f"{path}[{index}]", depth + 1))
    return found
