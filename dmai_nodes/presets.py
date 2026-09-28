"""Strict, data-only preset import. Registry IDs never come from imported code."""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import re

from .profiles import model_descriptor

MAX_FILE_BYTES = 128 * 1024
DEFAULT_SAMPLERS = ("euler", "euler_ancestral", "heun", "dpmpp_2m", "dpmpp_sde")
DEFAULT_SCHEDULERS = ("beta", "normal", "karras", "simple", "sgm_uniform")
_FORBIDDEN = {"__proto__", "prototype", "constructor"}


def exact_keys(value, keys, label):
    if type(value) is not dict or set(value) != set(keys):
        raise ValueError(f"{label} must contain exactly: {', '.join(keys)}.")


def number(value, low, high, label, integer=False):
    if (type(value) not in (int, float) or value < low or value > high or not math.isfinite(value)
            or (integer and (type(value) is not int))):
        raise ValueError(f"{label} must be {'an integer' if integer else 'a number'} from {low} to {high}.")
    return value


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result or key in _FORBIDDEN:
            raise ValueError("Duplicate or prototype-related JSON keys are not allowed.")
        result[key] = value
    return result


def read_json(value, label="JSON", max_bytes=MAX_FILE_BYTES):
    if isinstance(value, str):
        if len(value.encode("utf-8")) > max_bytes:
            raise ValueError(f"{label} exceeds its {max_bytes}-byte limit.")
        try:
            return json.loads(value, object_pairs_hook=_unique_object,
                              parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Non-finite JSON numbers are not allowed.")))
        except (json.JSONDecodeError, RecursionError) as exc:
            raise ValueError(f"{label} must contain valid JSON.") from exc
    if type(value) is not dict:
        raise ValueError(f"{label} must be a JSON object.")
    try:
        encoded = json.dumps(value, allow_nan=False)
    except (TypeError, ValueError, RecursionError) as exc:
        raise ValueError(f"{label} must contain JSON data only.") from exc
    return read_json(encoded, label, max_bytes)


def sampler_choices():
    try:
        from comfy.samplers import KSampler
    except ImportError:
        return list(DEFAULT_SAMPLERS), list(DEFAULT_SCHEDULERS)
    return list(KSampler.SAMPLERS), list(KSampler.SCHEDULERS)


def _text(value, max_length, label):
    if not isinstance(value, str):
        raise ValueError(f"{label} must be text.")
    value = value.strip()
    if (not value or len(value) > max_length or
            re.search(r"[\x00-\x1f\x7f-\x9f<>\u2028-\u202e\u2066-\u2069\ufeff]", value)):
        raise ValueError(f"{label} must contain 1-{max_length} visible characters without markup.")
    return value


def _slug(value, label):
    if not isinstance(value, str) or len(value) > 64 or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value):
        raise ValueError(f"{label} must be a lowercase slug of 1-64 characters.")
    return value


def validate_settings(settings, model):
    exact_keys(settings, ("steps", "cfg", "sampler", "scheduler", "denoise", "enhancer"), "Settings")
    steps = number(settings["steps"], 1, 150, "Steps", True)
    cfg = number(settings["cfg"], 0, 30, "CFG")
    denoise = number(settings["denoise"], 0, 1, "Denoise")
    samplers, schedulers = sampler_choices()
    if settings["sampler"] not in samplers or settings["scheduler"] not in schedulers:
        raise ValueError("Sampler or scheduler is unsupported by the installed ComfyUI.")
    if settings["enhancer"] not in ("none", "krea2t"):
        raise ValueError("Enhancer must be none or krea2t.")
    if settings["enhancer"] == "krea2t" and model["family"] != "krea2":
        raise ValueError("The Krea enhancer requires the Krea 2 profile.")
    return {"steps": steps, "cfg": cfg, "sampler": settings["sampler"], "scheduler": settings["scheduler"],
            "denoise": denoise, "enhancer": settings["enhancer"]}


def normalize_preset(value):
    exact_keys(value, ("schema_version", "id", "name", "model", "settings"), "Preset")
    if type(value["schema_version"]) is not int or value["schema_version"] != 1:
        raise ValueError("Preset schema_version must be 1.")
    model = value["model"]
    exact_keys(model, ("id", "label", "family"), "Model")
    _slug(model["id"], "Model ID")
    expected = model_descriptor(model["id"])
    if model != expected:
        raise ValueError("Model label and family must match the registered profile.")
    return {"schema_version": 1, "id": _slug(value["id"], "Preset ID"),
            "name": _text(value["name"], 80, "Preset name"), "model": expected,
            "settings": validate_settings(value["settings"], expected)}


def parse_preset_file(value):
    document = read_json(value, "Preset file")
    if type(document) is not dict:
        raise ValueError("Preset file must be an object.")
    if "presets" in document:
        exact_keys(document, ("schema_version", "presets"), "Preset pack")
        if type(document["schema_version"]) is not int or document["schema_version"] != 1:
            raise ValueError("Preset pack schema_version must be 1.")
        entries = document["presets"]
        if type(entries) is not list or not 1 <= len(entries) <= 20:
            raise ValueError("Preset packs must contain 1-20 presets.")
    else:
        entries = [document]
    presets = [normalize_preset(entry) for entry in entries]
    if len({entry["id"] for entry in presets}) != len(presets):
        raise ValueError("Preset IDs must be unique within a pack.")
    return presets


def get_builtin_presets():
    path = Path(__file__).resolve().parent.parent / "resources" / "presets" / "dmai-presets-v1.json"
    return parse_preset_file(path.read_text(encoding="utf-8"))


def preset_fingerprint(preset):
    encoded = json.dumps(preset, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def resolve_preset(preset_id, profile_id, imports):
    builtin = get_builtin_presets()
    builtin_ids = {entry["id"] for entry in builtin}
    if any(entry["id"] in builtin_ids for entry in imports):
        raise ValueError("Imported presets cannot replace built-in preset IDs. Use a new ID.")
    for source, entries in (("builtin", builtin), ("imported", imports)):
        for entry in entries:
            if entry["id"] == preset_id:
                if entry["model"]["id"] != profile_id:
                    raise ValueError("Preset belongs to a different model profile.")
                return deepcopy(entry), source
    raise ValueError("Selected preset was not found. Import it or choose a built-in preset.")
