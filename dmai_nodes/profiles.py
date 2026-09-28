"""Explicit generation adapters. A preset cannot register executable model support."""
from __future__ import annotations

from copy import deepcopy
import os
from pathlib import PurePosixPath


_PROFILES = {
    "krea2-turbo": {
        "id": "krea2-turbo", "label": "Krea 2 Turbo", "family": "krea2",
        "model_fields": [
            {"key": "diffusion_model", "inventory": "diffusion_models", "label": "Diffusion model", "required": True, "default": "krea2_turbo_fp8.safetensors"},
            {"key": "text_encoder", "inventory": "text_encoders", "label": "Text encoder", "required": True, "default": "qwen3vl_4b_fp8_scaled.safetensors"},
            {"key": "vae", "inventory": "vae", "label": "VAE", "required": True, "default": "wan_2.1_vae.safetensors"},
        ],
        "default_settings": {"steps": 8, "cfg": 1.1, "sampler": "euler", "scheduler": "beta", "denoise": 1, "enhancer": "none"},
        "resolution_multiple": 64, "max_dimension": 8192, "max_pixels": 16777216,
    },
    "sdxl-checkpoint": {
        "id": "sdxl-checkpoint", "label": "SDXL Checkpoint", "family": "sdxl",
        "model_fields": [
            {"key": "checkpoint", "inventory": "checkpoints", "label": "Checkpoint", "required": True, "default": ""},
        ],
        "default_settings": {"steps": 20, "cfg": 7, "sampler": "euler", "scheduler": "normal", "denoise": 1, "enhancer": "none"},
        "resolution_multiple": 64, "max_dimension": 8192, "max_pixels": 16777216,
    },
    "qwen-image": {
        "id": "qwen-image", "label": "Qwen Image", "family": "qwen_image",
        "model_fields": [
            {"key": "diffusion_model", "inventory": "diffusion_models", "label": "Diffusion model", "required": True, "default": "qwen_image_fp8_e4m3fn.safetensors"},
            {"key": "text_encoder", "inventory": "text_encoders", "label": "Qwen 2.5 VL encoder", "required": True, "default": "qwen_2.5_vl_7b_fp8_scaled.safetensors"},
            {"key": "vae", "inventory": "vae", "label": "VAE", "required": True, "default": "qwen_image_vae.safetensors"},
        ],
        "default_settings": {"steps": 20, "cfg": 4, "sampler": "euler", "scheduler": "simple", "denoise": 1, "enhancer": "none"},
        "resolution_multiple": 64, "max_dimension": 8192, "max_pixels": 16777216,
    },
    "flux1-dev": {
        "id": "flux1-dev", "label": "FLUX.1 Dev", "family": "flux",
        "model_fields": [
            {"key": "diffusion_model", "inventory": "diffusion_models", "label": "Diffusion model", "required": True, "default": "flux1-dev.safetensors"},
            {"key": "text_encoder", "inventory": "text_encoders", "label": "CLIP-L encoder", "required": True, "default": "clip_l.safetensors"},
            {"key": "text_encoder_2", "inventory": "text_encoders", "label": "T5 XXL encoder", "required": True, "default": "t5xxl_fp16.safetensors"},
            {"key": "vae", "inventory": "vae", "label": "VAE", "required": True, "default": "ae.safetensors"},
        ],
        "default_settings": {"steps": 20, "cfg": 1, "sampler": "euler", "scheduler": "simple", "denoise": 1, "enhancer": "none"},
        "default_guidance": 3.5,
        "resolution_multiple": 64, "max_dimension": 8192, "max_pixels": 16777216,
    },
}


def get_profiles():
    return deepcopy(list(_PROFILES.values()))


def get_profile(profile_id):
    if not isinstance(profile_id, str) or profile_id not in _PROFILES:
        raise ValueError("Unknown model profile. Choose a registered DMAI NODES adapter.")
    return deepcopy(_PROFILES[profile_id])


def model_descriptor(profile_id):
    profile = get_profile(profile_id)
    return {key: profile[key] for key in ("id", "label", "family")}


def canonical_name(value):
    """Normalize separators only. Preserve case and reject filesystem expressions."""
    if not isinstance(value, str) or not value or len(value) > 512:
        raise ValueError("Model filename must be a relative inventory name.")
    name = value.replace("\\", "/")
    parts = name.split("/")
    if (name.startswith("/") or ":" in name or any(part in ("", ".", "..") for part in parts)
            or any(ord(ch) < 32 or ord(ch) == 127 for ch in name)
            or PurePosixPath(name).is_absolute()):
        raise ValueError("Model filename must be a relative inventory name without traversal.")
    return name


def resolve_inventory_name(inventory, requested):
    """Return (native inventory name, metadata). Never guess a basename or case."""
    import folder_paths

    canonical = canonical_name(requested)
    matches = [name for name in folder_paths.get_filename_list(inventory)
               if canonical_name(name) == canonical]
    if len(matches) != 1:
        raise ValueError(f"Model '{canonical}' is missing or ambiguous in {inventory}.")
    native = matches[0]
    full_path = folder_paths.get_full_path(inventory, native)
    if not full_path or not os.path.isfile(full_path):
        raise ValueError(f"Model '{canonical}' is no longer available in {inventory}.")
    stat = os.stat(full_path)
    return native, {"name": canonical, "inventory": inventory, "size_bytes": stat.st_size,
                    "modified_ns": str(stat.st_mtime_ns)}


def resolve_model_files(profile_id, selections):
    profile = get_profile(profile_id)
    native, report = {}, {}
    for field in profile["model_fields"]:
        key = field["key"]
        native[key], report[key] = resolve_inventory_name(field["inventory"], selections.get(key, ""))
    return native, report
