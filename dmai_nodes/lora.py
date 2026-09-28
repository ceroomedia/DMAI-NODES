"""Validated, ordered LoRA recipes using ComfyUI's standard patch loader.

``loaded`` means nonzero patches were registered by ComfyUI. It does not
promise that deferred tensor application or a later GPU generation succeeded.
No tensors or model objects are cached by this module.
"""

from __future__ import annotations

from collections.abc import Mapping
from contextlib import contextmanager
import hashlib
import json
import logging
import math
from pathlib import Path
import re
import threading
import unicodedata
from typing import Any

MAX_MANIFEST_BYTES = 128 * 1024
MAX_ENTRIES = 64
MAX_STRENGTH = 20.0
_ENTRY_KEYS = {"id", "name", "enabled", "strength_model", "strength_clip"}
_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")


def _object_without_duplicates(pairs: list[tuple[str, Any]]) -> dict:
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"Duplicate LoRA JSON field: {key}")
        value[key] = item
    return value


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"LoRA JSON cannot contain {value}.")


def _canonical_name(value: Any) -> str:
    """Normalize separators only; never fold case or resolve a supplied path."""
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise ValueError("LoRA name must be a relative filename of 1–1024 characters.")
    name = value.replace("\\", "/")
    if any(unicodedata.category(char).startswith("C") for char in name):
        raise ValueError("LoRA filenames cannot contain control characters.")
    if name.startswith("/") or ":" in name or any(part in {"", ".", ".."} for part in name.split("/")):
        raise ValueError("LoRA name must be a relative ComfyUI catalog filename without traversal.")
    return name


def _strength(value: Any, field: str) -> float:
    if type(value) not in (int, float):
        raise ValueError(f"{field} must be a number, not a Boolean or string.")
    try:
        valid = math.isfinite(value) and -MAX_STRENGTH <= value <= MAX_STRENGTH
    except (OverflowError, ValueError):
        valid = False
    if not valid:
        raise ValueError(f"{field} must be finite and between -20 and 20.")
    return float(value)


def parse_manifest(value: str | dict) -> dict:
    """Return a fresh normalized v1 manifest or raise; never silently reset it."""
    if isinstance(value, str):
        try:
            size = len(value.encode("utf-8"))
        except UnicodeError as error:
            raise ValueError("LoRA JSON must be valid UTF-8 text.") from error
        if size > MAX_MANIFEST_BYTES:
            raise ValueError("LoRA manifest exceeds 128 KiB.")
        try:
            value = json.loads(value, object_pairs_hook=_object_without_duplicates, parse_constant=_reject_json_constant)
        except (json.JSONDecodeError, RecursionError) as error:
            raise ValueError("LoRA manifest is not valid JSON.") from error
    elif type(value) is not dict:
        raise ValueError("LoRA manifest must be a JSON object or JSON text.")

    if type(value) is not dict or set(value) != {"schema_version", "entries"}:
        raise ValueError("LoRA manifest requires exactly schema_version and entries.")
    if type(value["schema_version"]) is not int or value["schema_version"] != 1:
        raise ValueError("Unsupported LoRA schema_version; expected integer 1.")
    entries = value["entries"]
    if type(entries) is not list or len(entries) > MAX_ENTRIES:
        raise ValueError("LoRA entries must be a list containing at most 64 entries.")

    result = []
    ids = set()
    for position, entry in enumerate(entries, 1):
        if type(entry) is not dict or set(entry) != _ENTRY_KEYS:
            raise ValueError(f"LoRA entry {position} requires exactly id, name, enabled, strength_model and strength_clip.")
        entry_id = entry["id"]
        if not isinstance(entry_id, str) or not _ID_PATTERN.fullmatch(entry_id):
            raise ValueError(f"LoRA entry {position} has an invalid id; use 1–128 letters, numbers, underscores or hyphens.")
        if entry_id in ids:
            raise ValueError(f"Duplicate LoRA entry id: {entry_id}")
        ids.add(entry_id)
        if type(entry["enabled"]) is not bool:
            raise ValueError(f"LoRA entry {position}: enabled must be true or false, not a string or number.")
        result.append({
            "id": entry_id,
            "name": _canonical_name(entry["name"]),
            "enabled": entry["enabled"],
            "strength_model": _strength(entry["strength_model"], "strength_model"),
            "strength_clip": _strength(entry["strength_clip"], "strength_clip"),
        })
    normalized = {"schema_version": 1, "entries": result}
    if len(json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_MANIFEST_BYTES:
        raise ValueError("LoRA manifest exceeds 128 KiB.")
    return normalized


def _catalog() -> dict[str, str]:
    import folder_paths

    names = {}
    for native_name in folder_paths.get_filename_list("loras"):
        canonical = _canonical_name(native_name)
        if canonical in names and names[canonical] != native_name:
            raise ValueError(f"Ambiguous LoRA catalog name: {canonical}")
        names[canonical] = native_name
    return names


def list_loras() -> list[dict[str, str]]:
    """Expose canonical relative names and stable, case-preserving catalog IDs."""
    return [
        {"id": hashlib.sha256(name.encode("utf-8")).hexdigest(), "name": name}
        for name in sorted(_catalog())
    ]


def _is_active(entry: dict) -> bool:
    return entry["enabled"] and (entry["strength_model"] != 0 or entry["strength_clip"] != 0)


def _resolve(entries: list[dict]) -> dict[str, Path]:
    import folder_paths

    active = [entry for entry in entries if _is_active(entry)]
    if not active:
        return {}
    available = _catalog()
    paths = {}
    for entry in active:
        name = entry["name"]
        if name in paths:
            continue
        native_name = available.get(name)
        if native_name is None:
            raise FileNotFoundError(f"LoRA not found in ComfyUI's catalog (case-sensitive): {name}")
        try:
            path = folder_paths.get_full_path_or_raise("loras", native_name)
            resolved = Path(path)
            if not resolved.is_file():
                raise FileNotFoundError
        except (OSError, TypeError) as error:
            raise FileNotFoundError(f"LoRA catalog file is unavailable: {name}") from error
        paths[name] = resolved
    return paths


def validate_manifest_files(value: str | dict) -> dict:
    """Preflight active catalog files without loading tensors or models."""
    manifest = parse_manifest(value)
    _resolve(manifest["entries"])
    return manifest


def _stat_signature(path: Path) -> tuple[int, int, int, int]:
    info = path.stat()
    return info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_ino


def fingerprint_manifest(value: str | dict) -> str:
    """Content fingerprint used by Comfy execution caching.

    Streams active files in 1 MiB chunks. This deliberately trades disk reads
    for correctness when a file is replaced without changing its name or size.
    Disabled and zero-strength entries remain in the recipe hash but are not read.
    """
    manifest = parse_manifest(value)
    paths = _resolve(manifest["entries"])
    digest = hashlib.sha256(json.dumps(manifest, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    for name, path in paths.items():
        try:
            before = _stat_signature(path)
            file_digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    file_digest.update(chunk)
            if before != _stat_signature(path):
                raise ValueError(f"LoRA changed while fingerprinting; retry when the file is stable: {name}")
        except OSError as error:
            raise ValueError(f"Cannot read LoRA catalog file: {name}") from error
        digest.update(name.encode("utf-8"))
        digest.update(b"\x00")
        digest.update(file_digest.digest())
    return digest.hexdigest()


def _patch_counts(target: Any, *, clip: bool = False) -> dict[Any, int]:
    if target is None:
        return {}
    patcher = getattr(target, "patcher", None) if clip else target
    patches = getattr(patcher, "patches", None)
    if not isinstance(patches, Mapping):
        raise RuntimeError("This ComfyUI patcher does not expose verifiable LoRA patch counts. Update DMAI NODES before using this loader.")
    if any(not isinstance(items, (list, tuple)) for items in patches.values()):
        raise RuntimeError("Unrecognized ComfyUI LoRA patch storage; patch registration could not be verified.")
    return {key: len(items) for key, items in patches.items()}


def _added_patches(before: dict, after: dict) -> int:
    if any(after.get(key, 0) < count for key, count in before.items()):
        raise RuntimeError("ComfyUI removed existing patches during LoRA loading; refusing an unverifiable stack.")
    return sum(max(0, count - before.get(key, 0)) for key, count in after.items())


class _UnmatchedWarnings(logging.Handler):
    """Capture bounded standard-loader diagnostics from the current thread."""

    def __init__(self) -> None:
        super().__init__(logging.WARNING)
        self.thread_id = threading.get_ident()
        self.count = 0
        self.keys: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        if record.thread != self.thread_id:
            return
        message = record.getMessage()
        for prefix in ("lora key not loaded: ", "NOT LOADED "):
            if message.startswith(prefix):
                self.count += 1
                if len(self.keys) < 50:
                    self.keys.append(message[len(prefix):][:512])
                return


@contextmanager
def _capture_unmatched():
    handler = _UnmatchedWarnings()
    logger = logging.getLogger()
    logger.addHandler(handler)
    try:
        yield handler
    finally:
        logger.removeHandler(handler)
        handler.close()


def apply_loras(model: Any, clip: Any, value: str | dict) -> tuple[Any, Any, list[dict]]:
    """Apply in recipe order, retaining separate MODEL/CLIP strengths.

    All active files are resolved before the first load. Standard Comfy loading
    clones the inputs; an incompatible stack fails instead of reporting success.
    Reports describe registered patches, not deferred numerical/GPU execution.
    """
    manifest = parse_manifest(value)
    paths = _resolve(manifest["entries"])
    current_model, current_clip = model, clip
    reports = []
    for entry in manifest["entries"]:
        report = {
            **entry, "status": "disabled" if not entry["enabled"] else "zero_strength",
            "model_patches": 0, "clip_patches": 0,
            "unmatched_count": 0, "unmatched_keys": [],
            "verification": "not_loaded",
        }
        if not _is_active(entry):
            reports.append(report)
            continue

        import comfy.sd
        import comfy.utils

        before_model = _patch_counts(current_model)
        before_clip = _patch_counts(current_clip, clip=True)
        path = paths[entry["name"]]
        try:
            signature = _stat_signature(path)
            weights, metadata = comfy.utils.load_torch_file(str(path), safe_load=True, return_metadata=True)
            if signature != _stat_signature(path):
                raise ValueError(f"LoRA changed while loading; retry when the file is stable: {entry['name']}")
        except OSError as error:
            raise ValueError(f"Cannot load LoRA catalog file: {entry['name']}") from error

        with _capture_unmatched() as diagnostics:
            next_model, next_clip = comfy.sd.load_lora_for_models(
                current_model, current_clip, weights,
                entry["strength_model"], entry["strength_clip"], lora_metadata=metadata,
            )
        added_model = _added_patches(before_model, _patch_counts(next_model))
        added_clip = _added_patches(before_clip, _patch_counts(next_clip, clip=True))
        effective_model = added_model if entry["strength_model"] != 0 else 0
        effective_clip = added_clip if entry["strength_clip"] != 0 else 0
        if effective_model + effective_clip == 0:
            raise ValueError(
                f"LoRA registered no nonzero matching patches: {entry['name']}. "
                "Check the model family and separate MODEL/CLIP strengths."
            )
        report.update({
            "status": "partial" if diagnostics.count else "loaded",
            "model_patches": effective_model, "clip_patches": effective_clip,
            "unmatched_count": diagnostics.count, "unmatched_keys": diagnostics.keys,
            "verification": "registered_patches",
        })
        reports.append(report)
        current_model, current_clip = next_model, next_clip
        del weights, metadata
    return current_model, current_clip, reports


__all__ = [
    "MAX_ENTRIES", "MAX_MANIFEST_BYTES", "MAX_STRENGTH", "parse_manifest", "list_loras",
    "validate_manifest_files", "fingerprint_manifest", "apply_loras",
]
