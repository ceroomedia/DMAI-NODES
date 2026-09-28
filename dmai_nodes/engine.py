"""Model adapters using ComfyUI loaders, conditioning, sampling and interrupt checks."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import inspect
import json
from pathlib import Path
import re
import sys

from .presets import (exact_keys, get_builtin_presets, number, parse_preset_file,
                      preset_fingerprint, read_json, resolve_preset, validate_settings)
from .profiles import canonical_name, get_profile, model_descriptor, resolve_inventory_name, resolve_model_files

UINT64_MAX = (1 << 64) - 1
JS_SAFE_INTEGER = (1 << 53) - 1
ENHANCER_NODE_ID = "Krea2T-Enhancer-Advanced"
ENHANCER_CONFIG_KEY = "krea2t_prompt_adherence_enhancer_advanced"
ENHANCER_REPOSITORY = "https://github.com/capitan01R/ComfyUI-Krea2T-Enhancer"
_ENHANCER_RELEASES = {
    "1.1.0": {
        "commit": "50422e300258c35f1b824082ab8d5560bfefd5d3",
        "__init__.py": "086ef9c2f2ca2160e16f0e31560a660fd7d914c073af1a9658054a194d25f22c",
        "advanced.py": "621a272ade65216c54bdc6e3482629a932100c9a3f6f14efa2b45a0379298b11",
    },
    "1.4.2": {
        "commit": "e1f60f79e168c62b1cb1cf773dfb3ae4ee2292e2",
        "__init__.py": "5fe454feb4048286a6e9525d7e71ab64f6f142e0b73c4eede75aa708950fad3c",
        "advanced.py": "0893a97252b0632e73bd02c1a9948fc458ebe9f472ebce6f1e762b2dc99cb1c1",
    },
}


def validate_request(value):
    value = read_json(value, "Prompt request", max_bytes=192 * 1024)
    exact_keys(value, ("schema_version", "prompt", "negative_prompt", "width", "height", "count"), "Prompt request")
    if type(value["schema_version"]) is not int or value["schema_version"] != 1:
        raise ValueError("Prompt schema_version must be 1.")
    for key in ("prompt", "negative_prompt"):
        if not isinstance(value[key], str) or len(value[key]) > 65536 or "\x00" in value[key]:
            raise ValueError(f"{key} must be text of at most 65536 characters without null bytes.")
    width = number(value["width"], 64, 8192, "Width", True)
    height = number(value["height"], 64, 8192, "Height", True)
    if width % 64 or height % 64:
        raise ValueError("Width and height must be multiples of 64 pixels. Confirm the effective custom size first.")
    if width * height > 16777216:
        raise ValueError("An image may contain at most 16777216 pixels.")
    number(value["count"], 1, 8, "Image count", True)
    return deepcopy(value)


def parse_seed(value):
    if isinstance(value, str):
        if not re.fullmatch(r"0|[1-9][0-9]{0,19}", value):
            raise ValueError("Seed must be an unsigned decimal integer.")
        result = int(value)
    elif type(value) is int:
        if value > JS_SAFE_INTEGER:
            raise ValueError("Seeds above 9007199254740991 must be decimal strings to preserve precision.")
        result = value
    else:
        raise ValueError("Seed must be an integer or an unsigned decimal string.")
    if not 0 <= result <= UINT64_MAX:
        raise ValueError("Seed must be between 0 and 18446744073709551615.")
    return result


def parse_engine_config(value):
    value = read_json(value, "Engine configuration", max_bytes=160 * 1024)
    exact_keys(value, ("schema_version", "profile_id", "mode", "preset_id", "settings", "seed", "models", "presets"), "Engine configuration")
    if type(value["schema_version"]) is not int or value["schema_version"] != 1:
        raise ValueError("Engine schema_version must be 1.")
    profile = get_profile(value["profile_id"])
    if value["mode"] not in ("manual", "enhanced"):
        raise ValueError("Engine mode must be manual or enhanced.")
    if not isinstance(value["preset_id"], str) or len(value["preset_id"]) > 64:
        raise ValueError("Preset ID must be text of at most 64 characters.")
    settings = validate_settings(value["settings"], model_descriptor(profile["id"]))
    model_keys = {"diffusion_model", "text_encoder", "vae", "checkpoint"}
    if (type(value["models"]) is not dict or not model_keys.issubset(value["models"])
            or set(value["models"]) - model_keys - {"text_encoder_2"}):
        raise ValueError("Model selections require diffusion_model, text_encoder, vae and checkpoint; text_encoder_2 is optional for dual encoders.")
    models = {}
    for key, filename in value["models"].items():
        if not isinstance(filename, str):
            raise ValueError("Model selections must contain filenames as text.")
        models[key] = canonical_name(filename) if filename else ""
    if type(value["presets"]) is not list or len(value["presets"]) > 20:
        raise ValueError("Engine presets must contain at most 20 imported presets.")
    presets = parse_preset_file({"schema_version": 1, "presets": value["presets"]}) if value["presets"] else []
    builtin_ids = {entry["id"] for entry in get_builtin_presets()}
    if any(entry["id"] in builtin_ids for entry in presets):
        raise ValueError("Imported presets cannot replace built-in preset IDs. Use a new ID.")
    if value["mode"] == "enhanced":
        preset, _ = resolve_preset(value["preset_id"], profile["id"], presets)
        settings = preset["settings"]
    return {"schema_version": 1, "profile_id": profile["id"], "mode": value["mode"],
            "preset_id": value["preset_id"], "settings": settings,
            "seed": str(parse_seed(value["seed"])), "models": models, "presets": presets}


def _external_model_inputs(model, clip, vae):
    present = [item is not None for item in (model, clip, vae)]
    if any(present) and not all(present):
        raise ValueError("Connect MODEL, CLIP and VAE together, or leave all three disconnected.")
    return all(present)


def fingerprint_engine(value, *, model=None, clip=None, vae=None):
    """Fingerprint constant inputs without requiring linked objects at cache time.

    Comfy supplies only constants during its change check. Missing local files
    are stable markers here; execution still resolves every required file strictly.
    Linked node dependencies are tracked by Comfy's own cache.
    """
    config = parse_engine_config(value)
    if _external_model_inputs(model, clip, vae):
        files = {"source": "connected-inputs"}
    else:
        files = {}
        for field in get_profile(config["profile_id"])["model_fields"]:
            key = field["key"]
            name = config["models"].get(key, "")
            try:
                _, files[key] = resolve_inventory_name(field["inventory"], name)
            except (ValueError, OSError, ImportError):
                files[key] = {"name": name, "inventory": field["inventory"], "status": "unavailable"}
    enhancer = None
    if config["settings"]["enhancer"] == "krea2t":
        try:
            import nodes
            _, enhancer = _enhancer_dependency(nodes)
        except (ImportError, RuntimeError):
            enhancer = {"status": "unavailable-or-unsupported"}
    payload = {"config": config, "models": files, "enhancer": enhancer}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _enhancer_dependency(nodes):
    """Fail before model loading if an enhancement recipe cannot be reproduced."""
    cls = nodes.NODE_CLASS_MAPPINGS.get(ENHANCER_NODE_ID)
    if cls is None:
        raise RuntimeError("Krea / Original requires ComfyUI-Krea2T-Enhancer 1.1.0 or 1.4.2. Install the documented pinned version, restart ComfyUI, or choose Krea / Clean Base.")
    try:
        source = Path(inspect.getfile(cls)).resolve()
        if source.name != "advanced.py" or cls.FUNCTION != "apply":
            raise ValueError("Unexpected enhancer implementation.")
        package = source.parent
        metadata = (package / "pyproject.toml").read_text(encoding="utf-8")
        match = re.search(r'^version\s*=\s*"([^"]+)"', metadata, re.MULTILINE)
        version = match.group(1) if match else "unknown"
        expected = _ENHANCER_RELEASES.get(version)
        if not expected:
            raise ValueError("Unsupported enhancer version.")
        for name in ("__init__.py", "advanced.py"):
            # Git on Windows may convert line endings; normalize that harmless change.
            digest = hashlib.sha256((package / name).read_text(encoding="utf-8").encode("utf-8")).hexdigest()
            if digest != expected[name]:
                raise ValueError("Enhancer source differs from the pinned release.")
        required = cls.INPUT_TYPES().get("required", {})
        if set(required) != {"model", "enabled", "strength", "text_scale", "debug"}:
            raise ValueError("Unexpected enhancer inputs.")
        inspect.signature(cls.apply).bind(None, model=None, enabled=True, strength=1.0, text_scale=1.0, debug=False)
    except (OSError, TypeError, AttributeError, ValueError) as exc:
        raise RuntimeError("Installed Krea2T Enhancer does not match a supported pinned release. Reinstall the documented 1.1.0 or 1.4.2 commit; enhancement was not skipped.") from exc
    return cls, {"node_id": ENHANCER_NODE_ID, "version": version, "commit": expected["commit"],
                 "enabled": True, "strength": 1.0, "text_scale": 1.0, "debug": False,
                 "source_verified": True}


def _validate_loaded_models(profile, model, clip, vae):
    import comfy.model_base

    if model is None or clip is None or vae is None:
        raise RuntimeError("This model selection did not provide MODEL, CLIP and VAE.")
    family = profile["family"]
    expected = getattr(comfy.model_base, {"krea2": "Krea2", "sdxl": "SDXL", "qwen_image": "QwenImage", "flux": "Flux"}[family], None)
    if expected is None or type(model.model) is not expected:
        raise ValueError(f"The selected files are not a supported {profile['label']} model. Refiner, edit and other model families require their own adapter.")
    channels = 4 if family == "sdxl" else 16
    if getattr(model.model.latent_format, "latent_channels", None) != channels or getattr(vae, "latent_channels", None) != channels:
        raise ValueError("Model and VAE latent channels do not match the selected profile.")
    if vae.spacial_compression_decode() != 8:
        raise ValueError("The selected VAE has an unsupported spatial compression ratio.")
    if family in ("krea2", "qwen_image"):
        from comfy.ldm.wan.vae import WanVAE
        if family == "krea2":
            from comfy.text_encoders.krea2 import Krea2TEModel as Encoder
        else:
            from comfy.text_encoders.qwen_image import QwenImageTEModel as Encoder
        if not isinstance(clip.cond_stage_model, Encoder):
            raise ValueError(f"{profile['label']} requires its matching Qwen text encoder.")
        if (type(vae.first_stage_model) is not WanVAE or vae.latent_dim != 3
                or vae.output_channels != 3):
            raise ValueError(f"{profile['label']} requires its Wan 2.1 architecture RGB VAE.")
    elif family == "sdxl":
        from comfy.sdxl_clip import SDXLClipModel
        if not isinstance(clip.cond_stage_model, SDXLClipModel):
            raise ValueError("SDXL requires the checkpoint's dual CLIP text encoder.")
        if vae.latent_dim != 2 or vae.output_channels != 3:
            raise ValueError("SDXL requires a two-dimensional RGB VAE.")
    elif family == "flux":
        from comfy.text_encoders.flux import FluxClipModel
        if not isinstance(clip.cond_stage_model, FluxClipModel):
            raise ValueError("FLUX.1 requires its CLIP-L and T5 XXL dual encoder.")
        configuration = model.model.model_config.unet_config
        if not configuration.get("guidance_embed") or configuration.get("in_channels", 64) != 64:
            raise ValueError("This profile accepts FLUX.1 Dev text-to-image models. Schnell, Fill, Kontext and FLUX.2 need separate adapters.")
        if vae.latent_dim != 2 or vae.output_channels != 3:
            raise ValueError("FLUX.1 requires a two-dimensional RGB VAE.")


def _load_models(nodes, profile, files):
    if profile["family"] in ("krea2", "qwen_image", "flux"):
        encoder_type = profile["family"]
        loader = nodes.DualCLIPLoader if encoder_type == "flux" else nodes.CLIPLoader
        choices = loader.INPUT_TYPES()["required"]["type"][0]
        if encoder_type not in choices:
            raise RuntimeError(f"This ComfyUI version has no {profile['label']} encoder. Update to the documented baseline.")
        model = nodes.UNETLoader().load_unet(files["diffusion_model"], "default")[0]
        if encoder_type == "flux":
            clip = loader().load_clip(files["text_encoder"], files["text_encoder_2"], type="flux", device="default")[0]
        else:
            clip = loader().load_clip(files["text_encoder"], type=encoder_type, device="default")[0]
        vae = nodes.VAELoader().load_vae(files["vae"])[0]
    else:
        model, clip, vae = nodes.CheckpointLoaderSimple().load_checkpoint(files["checkpoint"])
    _validate_loaded_models(profile, model, clip, vae)
    return model, clip, vae


def _apply_enhancer(model, cls, dependency):
    options = getattr(model, "model_options", {}).get("transformer_options", {})
    if ENHANCER_CONFIG_KEY in options:
        raise ValueError("This MODEL already has a Krea enhancer. Use only one enhancer and choose Krea / Clean Base, or Manual with enhancer none, in the Generation Engine.")
    module = sys.modules.get(cls.__module__)
    supported = getattr(module, "_is_krea2_dm", None)
    if not callable(supported) or not supported(model.model.diffusion_model):
        raise ValueError("The loaded Krea diffusion model does not support the requested enhancer layout.")
    enhanced = cls().apply(model=model, enabled=True, strength=dependency["strength"], text_scale=dependency["text_scale"], debug=False)[0]
    config = enhanced.model_options.get("transformer_options", {}).get(ENHANCER_CONFIG_KEY, {})
    expected = {key: dependency[key] for key in ("enabled", "strength", "text_scale", "debug")}
    if config != expected:
        raise RuntimeError("Krea enhancer did not attach the requested configuration.")
    return enhanced


def apply_krea_enhancer(model, strength=1.0, text_scale=1.0):
    """Standalone Krea-only patch. Other model families fail clearly."""
    number(strength, 0, 2, "Enhancer strength")
    number(text_scale, 0.25, 4, "Text scale")
    import nodes
    import comfy.model_base
    expected = getattr(comfy.model_base, "Krea2", None)
    if expected is None or type(getattr(model, "model", None)) is not expected:
        raise ValueError("DMAI Krea Enhancer accepts Krea 2 MODEL inputs only.")
    cls, dependency = _enhancer_dependency(nodes)
    dependency.update(strength=strength, text_scale=text_scale)
    return _apply_enhancer(model, cls, dependency)


def _conditioning(nodes, profile, clip, text, request):
    conditioning = nodes.CLIPTextEncode().encode(clip, text)[0]
    if profile["family"] == "sdxl":
        dimensions = {"width": request["width"], "height": request["height"], "crop_w": 0, "crop_h": 0,
                      "target_width": request["width"], "target_height": request["height"]}
        conditioning = [[tensor, {**metadata, **dimensions}] for tensor, metadata in conditioning]
    elif profile["family"] == "flux":
        conditioning = [[tensor, {**metadata, "guidance": profile["default_guidance"]}] for tensor, metadata in conditioning]
    return conditioning


def _sigma_schedule(sigmas):
    import torch
    if (not torch.is_tensor(sigmas) or not torch.is_floating_point(sigmas)
            or sigmas.ndim != 1 or not 2 <= sigmas.numel() <= 10001):
        raise ValueError("SIGMAS must be a one-dimensional floating-point tensor with 2-10001 values. Callable schedules must be resolved with their model first.")
    values = sigmas.detach().to(device="cpu", dtype=torch.float64)
    if not bool(torch.isfinite(values).all()) or bool((values < 0).any()):
        raise ValueError("SIGMAS must contain finite, nonnegative values.")
    if values[0].item() <= 0 or values[-1].item() != 0 or bool((values[1:] >= values[:-1]).any()):
        raise ValueError("The Generation Engine requires a strictly descending generation schedule ending at zero. Duplicate or unsampling schedules need a dedicated workflow.")
    return {"steps": sigmas.numel() - 1, "start": values[0].item(), "end": values[-1].item(),
            "sha256": hashlib.sha256(values.numpy().tobytes()).hexdigest()}


def _prepare_input_latent(latent, model, request):
    import torch
    import comfy.sample
    if (type(latent) is not dict or "samples" not in latent or not torch.is_tensor(latent["samples"])
            or not torch.is_floating_point(latent["samples"])):
        raise ValueError("Connected LATENT must contain a floating-point samples tensor.")
    samples = comfy.sample.fix_empty_latent_channels(model, latent["samples"],
                                                    latent.get("downscale_ratio_spacial"), latent.get("downscale_ratio_temporal"))
    latent_format = model.model.latent_format
    spatial = latent_format.spacial_downscale_ratio
    expected = (1, latent_format.latent_channels)
    if latent_format.latent_dimensions == 3:
        expected += (1,)
    expected += (request["height"] // spatial, request["width"] // spatial)
    if tuple(samples.shape) != expected or not bool(torch.isfinite(samples).all()):
        raise ValueError("Connected LATENT must contain one finite image matching the Prompter dimensions and the selected model format.")
    result = latent.copy()
    result["samples"] = samples
    result.pop("downscale_ratio_spacial", None)
    result.pop("downscale_ratio_temporal", None)
    return result


def execute_engine(request, config, loras=None, *, sampler=None, sigmas=None,
                   model=None, clip=None, vae=None, latent=None, positive=None, negative=None):
    """Render one image per seed, in order. Comfy interruptions propagate unchanged.

    The first public adapter uses standard EmptyLatentImage and KSampler. The
    documented Comfy baseline converts this empty latent to the model's channel
    count and temporal dimensions in common_ksampler/fix_empty_latent_channels.
    """
    request = validate_request(request)
    config = parse_engine_config(config)
    from . import __version__ as package_version
    profile = get_profile(config["profile_id"])
    settings = config["settings"]
    external_models = _external_model_inputs(model, clip, vae)
    if (positive is None) != (negative is None):
        raise ValueError("Connect positive and negative CONDITIONING together, or leave both disconnected.")
    external_conditioning = positive is not None
    external_sampler = sampler is not None
    external_sigmas = sigmas is not None
    custom_sampling = external_sampler or external_sigmas
    schedule = _sigma_schedule(sigmas) if sigmas is not None else None
    if external_sampler:
        if not callable(getattr(sampler, "sample", None)):
            raise ValueError("SAMPLER must be a Comfy-compatible sampler object with a sample method.")
        options = getattr(sampler, "extra_options", {})
        if type(options) is dict and options.get("sigmas_override") is not None:
            raise ValueError("The connected SAMPLER has a hidden sigmas_override. Remove it and connect that schedule to the Engine SIGMAS input.")
        if type(options) is dict and options.get("sampler_mode", "standard") != "standard":
            raise ValueError("The Generation Engine supports standard generation samplers. RES4LYF unsample/resample modes require their dedicated workflow.")
    from .lora import apply_loras, validate_manifest_files
    manifest = validate_manifest_files(loras if loras is not None else {"schema_version": 1, "entries": []})
    import nodes
    import torch
    import comfy.model_management

    interrupt = comfy.model_management.throw_exception_if_processing_interrupted
    interrupt()
    enhancer_cls, enhancer_info = None, {"enabled": False}
    if settings["enhancer"] == "krea2t":
        enhancer_cls, enhancer_info = _enhancer_dependency(nodes)
    started = datetime.now(timezone.utc).isoformat()
    if external_models:
        _validate_loaded_models(profile, model, clip, vae)
        model_report = {"source": "connected-inputs", "file_identity": "owned-by-upstream-loader"}
    else:
        files, model_report = resolve_model_files(profile["id"], config["models"])
        model, clip, vae = _load_models(nodes, profile, files)
    interrupt()
    if external_conditioning and any(entry["enabled"] and entry["strength_clip"] != 0 for entry in manifest["entries"]):
        raise ValueError("Pre-encoded conditioning cannot receive CLIP LoRAs retroactively. Set their CLIP strength to zero or let the engine encode both prompts.")
    model, clip, lora_report = apply_loras(model, clip, manifest)
    if enhancer_cls is not None:
        model = _apply_enhancer(model, enhancer_cls, enhancer_info)
    elif external_models:
        existing = getattr(model, "model_options", {}).get("transformer_options", {}).get(ENHANCER_CONFIG_KEY)
        if existing:
            enhancer_info = {"source": "connected-model", "verification": "owned-by-upstream-node", **deepcopy(existing)}
    if custom_sampling:
        if sampler is None:
            import comfy.samplers
            sampler = comfy.samplers.sampler_object(settings["sampler"])
        if sigmas is None:
            from comfy_extras.nodes_custom_sampler import BasicScheduler
            sigmas = BasicScheduler.execute(model=model, scheduler=settings["scheduler"], steps=settings["steps"], denoise=settings["denoise"])[0]
            schedule = _sigma_schedule(sigmas)
    # Both prompts must use the LoRA-patched encoder, in the same order as MODEL.
    if not external_conditioning:
        positive = _conditioning(nodes, profile, clip, request["prompt"], request)
        interrupt()
        negative = _conditioning(nodes, profile, clip, request["negative_prompt"], request)
    prepared_latent = _prepare_input_latent(latent, model, request) if latent is not None else None
    images, image_report = [], []
    seed = int(config["seed"])
    for index in range(request["count"]):
        interrupt()
        image_seed = (seed + index) & UINT64_MAX
        if prepared_latent is None:
            image_latent = nodes.EmptyLatentImage().generate(request["width"], request["height"], batch_size=1)[0]
        else:
            image_latent = {key: value.clone() if torch.is_tensor(value) else deepcopy(value) for key, value in prepared_latent.items()}
        if not custom_sampling:
            samples = nodes.KSampler().sample(model=model, seed=image_seed, steps=settings["steps"], cfg=settings["cfg"],
                                             sampler_name=settings["sampler"], scheduler=settings["scheduler"],
                                             positive=positive, negative=negative, latent_image=image_latent, denoise=settings["denoise"])[0]
        else:
            from comfy_extras.nodes_custom_sampler import SamplerCustom
            result = SamplerCustom.execute(model=model, add_noise=True, noise_seed=image_seed, cfg=settings["cfg"],
                                           positive=positive, negative=negative, sampler=sampler, sigmas=sigmas,
                                           latent_image=image_latent)
            samples = result[0]
        interrupt()
        decoded = nodes.VAEDecode().decode(vae, samples)[0]
        if tuple(decoded.shape) != (1, request["height"], request["width"], 3):
            raise RuntimeError("The model returned unexpected image dimensions or count; generation stopped.")
        images.append(decoded.to(device="cpu"))
        image_report.append({"index": index, "seed": str(image_seed)})
    interrupt()
    preset_info = None
    if config["mode"] == "enhanced":
        preset, source = resolve_preset(config["preset_id"], profile["id"], config["presets"])
        preset_info = {"id": preset["id"], "name": preset["name"], "source": source, "sha256": preset_fingerprint(preset)}
    try:
        from comfyui_version import __version__ as comfy_version
    except ImportError:
        comfy_version = "unavailable"
    report = {"schema_version": 1, "status": "completed", "profile": model_descriptor(profile["id"]),
              "request": request, "mode": config["mode"], "settings": deepcopy(settings), "preset": preset_info,
              "models": model_report, "loras": lora_report, "enhancer": enhancer_info,
              "images": image_report, "seed_policy": "seed-plus-index-modulo-2^64", "comfyui_version": comfy_version,
              "dmai_nodes_version": package_version,
              "started_at": started, "completed_at": datetime.now(timezone.utc).isoformat()}
    report["conditioning_source"] = "connected-inputs" if external_conditioning else "engine-after-loras"
    report["latent_source"] = "connected-input" if prepared_latent is not None else "empty-latent"
    if profile["family"] == "flux":
        report["flux_guidance"] = "provided-by-conditioning" if external_conditioning else profile["default_guidance"]
    if custom_sampling:
        overridden = (["sampler"] if external_sampler else []) + (["steps", "scheduler", "denoise"] if external_sigmas else [])
        report["effective_sampling"] = {"path": "custom-sampler", "sampler_type": type(sampler).__name__,
                                        "sampler_source": "connected-input" if external_sampler else settings["sampler"],
                                        "schedule_source": "connected-input" if external_sigmas else "native-basic-scheduler",
                                        "cfg": settings["cfg"], "input_schedule": schedule,
                                        "trajectory_verification": "The sampler implementation may transform the input schedule internally.",
                                        "overridden_settings": overridden}
    else:
        report["effective_sampling"] = {"path": "native-ksampler", **deepcopy(settings)}
    return torch.cat(images, dim=0), report
