"""Engine contract and call-order tests using isolated Comfy interfaces, no GPU."""
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from dmai_nodes import engine
from dmai_nodes.presets import get_builtin_presets
from dmai_nodes.profiles import get_profiles, resolve_inventory_name

try:
    import torch as real_torch
except ImportError:
    real_torch = None


def request(count=2):
    return {"schema_version": 1, "prompt": "A ceramic cup", "negative_prompt": "blur", "width": 832, "height": 1024, "count": count}


def config():
    return {"schema_version": 1, "profile_id": "krea2-turbo", "mode": "manual", "preset_id": "",
            "settings": {"steps": 12, "cfg": 1.3, "sampler": "heun", "scheduler": "simple", "denoise": 0.8, "enhancer": "none"},
            "seed": "18446744073709551615", "models": {"diffusion_model": "krea.safetensors", "text_encoder": "clip.safetensors", "vae": "vae.safetensors", "checkpoint": ""}, "presets": []}


class Tensor:
    def __init__(self, shape):
        self.shape = shape

    def to(self, **kwargs):
        return self


class Runtime:
    def __init__(self):
        self.calls = []
        self.interrupted = False
        self.patched_clip = object()
        self.model = object()
        runtime = self

        class Encoder:
            def encode(self, clip, text):
                runtime.calls.append(("encode", clip, text))
                return ([[text, {}]],)

        class Latent:
            def generate(self, width, height, batch_size):
                runtime.calls.append(("latent", width, height, batch_size))
                return ({"width": width, "height": height},)

        class Sampler:
            def sample(self, **kwargs):
                runtime.calls.append(("sample", kwargs))
                return (kwargs["latent_image"],)

        class Decoder:
            def decode(self, vae, samples):
                runtime.calls.append(("decode", samples))
                return (Tensor((1, samples["height"], samples["width"], 3)),)

        class CustomSampler:
            @classmethod
            def execute(cls, **kwargs):
                runtime.calls.append(("custom_sample", kwargs))
                return (kwargs["latent_image"],)

        class Scheduler:
            @classmethod
            def execute(cls, **kwargs):
                runtime.calls.append(("scheduler", kwargs))
                return ("scheduled-sigmas",)

        self.nodes = types.SimpleNamespace(CLIPTextEncode=Encoder, EmptyLatentImage=Latent,
                                           KSampler=Sampler, VAEDecode=Decoder, NODE_CLASS_MAPPINGS={})
        self.management = types.ModuleType("comfy.model_management")
        self.management.throw_exception_if_processing_interrupted = self.interrupt
        self.comfy = types.ModuleType("comfy")
        self.comfy.__path__ = []
        self.comfy.model_management = self.management
        self.samplers = types.ModuleType("comfy.samplers")
        self.samplers.KSampler = types.SimpleNamespace(SAMPLERS=("euler", "heun"), SCHEDULERS=("beta", "normal", "simple"))
        self.samplers.sampler_object = lambda name: types.SimpleNamespace(name=name)
        self.comfy.samplers = self.samplers
        self.extras = types.ModuleType("comfy_extras")
        self.extras.__path__ = []
        self.custom = types.ModuleType("comfy_extras.nodes_custom_sampler")
        self.custom.SamplerCustom = CustomSampler
        self.custom.BasicScheduler = Scheduler
        self.torch = types.SimpleNamespace(cat=lambda images, dim: Tensor((len(images), *images[0].shape[1:])))

    def interrupt(self):
        if self.interrupted:
            raise InterruptedError("User cancelled")

    def apply_loras(self, model, clip, recipe):
        self.calls.append(("loras", recipe))
        return self.model, self.patched_clip, [{"status": "loaded"}]

    def modules(self):
        return {"nodes": self.nodes, "torch": self.torch, "comfy": self.comfy, "comfy.model_management": self.management,
                "comfy.samplers": self.samplers, "comfy_extras": self.extras, "comfy_extras.nodes_custom_sampler": self.custom}


class ValidationTests(unittest.TestCase):
    def test_request_count_dimensions_and_types(self):
        self.assertEqual(engine.validate_request(request()), request())
        for field, value in (("count", 0), ("count", 9), ("count", True), ("width", 1080), ("height", 8193),
                             ("prompt", 12), ("prompt", "x\0"), ("schema_version", True)):
            value_request = request()
            value_request[field] = value
            with self.subTest(field=field, value=value):
                with self.assertRaises(ValueError):
                    engine.validate_request(value_request)
        large = request()
        large.update(width=8192, height=8192)
        with self.assertRaises(ValueError):
            engine.validate_request(large)

    def test_seed_decimal_precision(self):
        self.assertEqual(engine.parse_seed("18446744073709551615"), engine.UINT64_MAX)
        for value in (True, 1.0, "1.0", "-1", "01", " 12", "18446744073709551616", 9007199254740992):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    engine.parse_seed(value)

    def test_enhanced_resolves_preset_not_stale_manual_values(self):
        value = config()
        value.update(mode="enhanced", preset_id="dmai-krea2-original-v1")
        result = engine.parse_engine_config(value)
        self.assertEqual(result["settings"], get_builtin_presets()[0]["settings"])
        self.assertEqual(value["settings"]["steps"], 12)

    def test_enhanced_without_upload_has_an_actionable_error(self):
        value = config()
        value["mode"] = "enhanced"
        with self.assertRaisesRegex(ValueError, "Upload a DMAI JSON preset.*or switch.*Manual"):
            engine.parse_engine_config(value)

    def test_imported_enhanced_settings_keep_legacy_preset_resolution(self):
        value = config()
        preset = deepcopy(get_builtin_presets()[0])
        preset.update(id="dmai-imported-settings", name="My DMAI settings")
        preset["settings"].update(steps=18, enhancer="none")
        value.update(mode="enhanced", preset_id=preset["id"], presets=[preset])
        self.assertEqual(engine.parse_engine_config(value)["settings"], preset["settings"])

    def test_imports_cannot_enable_unknown_adapters_or_shadow_presets(self):
        value = config()
        value["presets"] = [get_builtin_presets()[0]]
        with self.assertRaises(ValueError):
            engine.parse_engine_config(value)
        value = config()
        value["profile_id"] = "flux-demo"
        with self.assertRaises(ValueError):
            engine.parse_engine_config(value)

    def test_inventory_separator_normalization_and_exact_case(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.safetensors"
            path.write_bytes(b"model")
            folder = types.SimpleNamespace(get_filename_list=lambda _: ["Folder\\Model.safetensors"],
                                           get_full_path=lambda inventory, name: str(path))
            with patch.dict(sys.modules, {"folder_paths": folder}):
                native, report = resolve_inventory_name("diffusion_models", "Folder/Model.safetensors")
                self.assertEqual(native, "Folder\\Model.safetensors")
                self.assertEqual(report["name"], "Folder/Model.safetensors")
                for invalid in ("folder/model.safetensors", "../model", "C:/file", "/file", "x//file"):
                    with self.assertRaises(ValueError):
                        resolve_inventory_name("diffusion_models", invalid)

    def test_profiles_are_isolated_copies(self):
        profiles = get_profiles()
        profiles[0]["model_fields"].clear()
        self.assertEqual(len(get_profiles()[0]["model_fields"]), 3)

    def test_existing_enhancer_is_never_silently_replaced(self):
        for existing in ({"enabled": True, "strength": 0.7}, {"enabled": False}, {}):
            model = types.SimpleNamespace(model_options={"transformer_options": {engine.ENHANCER_CONFIG_KEY: existing}})
            original = deepcopy(model.model_options)
            with self.assertRaisesRegex(ValueError, "Clean Base"):
                engine._apply_enhancer(model, None, {})
            self.assertEqual(model.model_options, original)


class ExecutionTests(unittest.TestCase):
    def execute(self, runtime, value=None, **advanced):
        with patch.dict(sys.modules, runtime.modules()), \
             patch("dmai_nodes.lora.validate_manifest_files", side_effect=lambda manifest: manifest), \
             patch("dmai_nodes.lora.apply_loras", side_effect=runtime.apply_loras), \
             patch.object(engine, "resolve_model_files", return_value=({}, {})), \
             patch.object(engine, "_load_models", return_value=(object(), object(), object())):
            return engine.execute_engine(request(), value or config(), {"schema_version": 1, "entries": []}, **advanced)

    def test_order_effective_settings_count_and_wrapping_seeds(self):
        runtime = Runtime()
        images, report = self.execute(runtime)
        self.assertEqual(images.shape, (2, 1024, 832, 3))
        self.assertEqual([row[0] for row in runtime.calls], ["loras", "encode", "encode", "latent", "sample", "decode", "latent", "sample", "decode"])
        encoded = [row for row in runtime.calls if row[0] == "encode"]
        self.assertTrue(all(row[1] is runtime.patched_clip for row in encoded))
        samples = [row[1] for row in runtime.calls if row[0] == "sample"]
        self.assertEqual([item["seed"] for item in samples], [engine.UINT64_MAX, 0])
        for sample in samples:
            self.assertEqual((sample["steps"], sample["cfg"], sample["sampler_name"], sample["scheduler"], sample["denoise"]), (12, 1.3, "heun", "simple", 0.8))
        self.assertEqual([item["seed"] for item in report["images"]], [str(engine.UINT64_MAX), "0"])
        self.assertIsNone(report["preset"])

    def test_engine_reports_each_sample_and_decode_with_failure_cleanup(self):
        from dmai_nodes.progress import GenerationProgress
        from test_progress import Registry
        for fail in (False, True):
            runtime = Runtime()
            registry = Registry()
            events = []
            progress = GenerationProgress(registry=registry, send=lambda _, payload, sid: events.append(payload),
                                          prompt_id="job-1", node_id="engine-1", client_id="owner-client")
            original_sample = runtime.nodes.KSampler.sample
            original_decode = runtime.nodes.VAEDecode.decode

            def sample(instance, **kwargs):
                registry.update(6, 12)
                if fail:
                    raise RuntimeError("native sampling failure")
                registry.update(12, 12)
                return original_sample(instance, **kwargs)

            def decode(instance, vae, samples):
                registry.update(500, 500)  # VAE internals must not become sampler steps.
                return original_decode(instance, vae, samples)

            with self.subTest(fail=fail), patch.object(GenerationProgress, "from_comfy", return_value=progress), \
                 patch.object(runtime.nodes.KSampler, "sample", sample), \
                 patch.object(runtime.nodes.VAEDecode, "decode", decode):
                if fail:
                    with self.assertRaisesRegex(RuntimeError, "native sampling failure"):
                        self.execute(runtime)
                    self.assertEqual(events[-1]["phase"], "error")
                else:
                    self.execute(runtime)
                    self.assertEqual(events[-1]["phase"], "complete")
                    half_steps = [item for item in events if item["phase"] == "sampling" and item["value"] == 6]
                    self.assertEqual([item["image_index"] for item in half_steps], [0, 1])
                    self.assertFalse(any(item["value"] == 500 for item in events))
                    self.assertEqual(events[-1]["fraction"], 1)
                self.assertEqual(registry.handlers, {})

    def test_missing_enhancer_fails_before_model_load(self):
        runtime = Runtime()
        value = config()
        value.update(mode="enhanced", preset_id="dmai-krea2-original-v1")
        with patch.object(engine, "_load_models") as loader:
            with self.assertRaisesRegex(RuntimeError, "requires ComfyUI-Krea2T"):
                self.execute(runtime, value)
            loader.assert_not_called()
        self.assertEqual(runtime.calls, [])

    def test_interrupt_is_not_swallowed_or_retried(self):
        runtime = Runtime()
        runtime.interrupted = True
        with self.assertRaises(InterruptedError):
            self.execute(runtime)
        self.assertEqual(runtime.calls, [])

    def test_sdxl_dimensions_are_in_both_conditionings(self):
        runtime = Runtime()
        value = config()
        value.update(profile_id="sdxl-checkpoint")
        self.execute(runtime, value)
        samples = [row[1] for row in runtime.calls if row[0] == "sample"]
        for field in ("positive", "negative"):
            self.assertEqual(samples[0][field][0][1]["target_width"], 832)
            self.assertEqual(samples[0][field][0][1]["height"], 1024)

    def test_fingerprint_changes_when_model_is_replaced(self):
        with patch.object(engine, "resolve_inventory_name", return_value=("file", {"size_bytes": 4})):
            first = engine.fingerprint_engine(config())
        with patch.object(engine, "resolve_inventory_name", return_value=("file", {"size_bytes": 5})):
            second = engine.fingerprint_engine(config())
        self.assertNotEqual(first, second)

    def test_fingerprint_uses_missing_markers_until_files_are_installed(self):
        with patch.object(engine, "resolve_inventory_name", side_effect=ValueError("missing")):
            first = engine.fingerprint_engine(config())
            self.assertEqual(first, engine.fingerprint_engine(config()))
        with patch.object(engine, "resolve_inventory_name", return_value=("file", {"size_bytes": 4})):
            self.assertNotEqual(first, engine.fingerprint_engine(config()))

    def test_external_sampler_with_native_schedule_preserves_manual_settings(self):
        runtime = Runtime()
        external = types.SimpleNamespace(extra_options={"sampler_mode": "standard"}, sample=lambda: None)
        with patch.object(engine, "_sigma_schedule", return_value={"steps": 12, "start": 1.0, "end": 0.0}):
            _, report = self.execute(runtime, sampler=external)
        schedule_call = next(row[1] for row in runtime.calls if row[0] == "scheduler")
        self.assertEqual((schedule_call["steps"], schedule_call["scheduler"], schedule_call["denoise"]), (12, "simple", 0.8))
        sampling = [row[1] for row in runtime.calls if row[0] == "custom_sample"]
        self.assertEqual(len(sampling), 2)
        self.assertTrue(all(row["sampler"] is external for row in sampling))
        self.assertEqual(report["effective_sampling"]["overridden_settings"], ["sampler"])
        self.assertFalse(any(row[0] == "sample" for row in runtime.calls))

    def test_external_sigmas_with_native_sampler_reports_overrides(self):
        runtime = Runtime()
        with patch.object(engine, "_sigma_schedule", return_value={"steps": 3, "start": 1.0, "end": 0.0}):
            _, report = self.execute(runtime, sigmas="external-schedule")
        sampling = [row[1] for row in runtime.calls if row[0] == "custom_sample"]
        self.assertEqual(sampling[0]["sampler"].name, "heun")
        self.assertEqual(sampling[0]["sigmas"], "external-schedule")
        self.assertEqual(report["effective_sampling"]["overridden_settings"], ["steps", "scheduler", "denoise"])
        self.assertFalse(any(row[0] == "scheduler" for row in runtime.calls))

    def test_external_sampler_cannot_hide_schedule_or_unsampling_mode(self):
        for options in ({"sigmas_override": "hidden"}, {"sampler_mode": "unsample"}, {"sampler_mode": "resample"}):
            runtime = Runtime()
            with self.assertRaises(ValueError):
                self.execute(runtime, sampler=types.SimpleNamespace(extra_options=options, sample=lambda: None))
            self.assertFalse(any(row[0] in ("sample", "custom_sample") for row in runtime.calls))

    def test_partial_external_model_triplet_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "MODEL, CLIP and VAE"):
            self.execute(Runtime(), model=object())

    def test_external_model_triplet_skips_loaders(self):
        runtime = Runtime()
        with patch.object(engine, "_validate_loaded_models") as validate, \
             patch.dict(sys.modules, runtime.modules()), \
             patch("dmai_nodes.lora.validate_manifest_files", side_effect=lambda manifest: manifest), \
             patch("dmai_nodes.lora.apply_loras", side_effect=runtime.apply_loras), \
             patch.object(engine, "resolve_model_files") as resolver, \
             patch.object(engine, "_load_models") as loader:
            images, report = engine.execute_engine(request(), config(), model=object(), clip=object(), vae=object())
        resolver.assert_not_called()
        loader.assert_not_called()
        validate.assert_called_once()
        self.assertEqual(images.shape[0], 2)
        self.assertEqual(report["models"]["source"], "connected-inputs")

    def test_flux_conditioning_declares_guidance_and_no_krea_enhancement(self):
        runtime = Runtime()
        value = config()
        value["profile_id"] = "flux1-dev"
        _, report = self.execute(runtime, value)
        sampling = next(row[1] for row in runtime.calls if row[0] == "sample")
        self.assertEqual(sampling["positive"][0][1]["guidance"], 3.5)
        self.assertEqual(report["flux_guidance"], 3.5)
        self.assertEqual(report["enhancer"], {"enabled": False})


@unittest.skipIf(real_torch is None, "CPU tensor checks require the ComfyUI Python environment")
class SigmaTensorTests(unittest.TestCase):
    def test_cpu_sigma_tensor_validation(self):
        values = real_torch.tensor([1.0, 0.8, 0.2, 0.0])
        result = engine._sigma_schedule(values)
        self.assertEqual(result["steps"], 3)
        self.assertEqual((result["start"], result["end"]), (1, 0))
        self.assertEqual(len(result["sha256"]), 64)

    def test_invalid_and_callable_sigmas_are_rejected(self):
        for values in (lambda model: model, [1, 0], real_torch.tensor([1.0]), real_torch.tensor([[1.0, 0.0]]),
                       real_torch.tensor([float("nan"), 0.0]), real_torch.tensor([-1.0, 0.0]),
                       real_torch.tensor([0.0, 1.0]), real_torch.tensor([1.0, 0.5]), real_torch.zeros(10002),
                       real_torch.tensor([1, 0]), real_torch.tensor([True, False]), real_torch.tensor([1+1j, 0j]),
                       real_torch.tensor([1.0, 1.0, 0.0])):
            with self.subTest(value=type(values)):
                with self.assertRaises(ValueError):
                    engine._sigma_schedule(values)


@unittest.skipUnless(os.environ.get("DMAI_RUN_COMFY_TESTS") == "1", "Opt-in real ComfyUI CPU comparison")
class RealComfyEngineTests(unittest.TestCase):
    """Check real core latent and V3 scheduler boundaries without loading weights."""
    @classmethod
    def setUpClass(cls):
        source = Path(os.environ.get("DMAI_COMFY_SOURCE", Path(__file__).resolve().parents[1] / ".validation" / "ComfyUI")).resolve()
        sys.path.insert(0, str(source))
        cls.addClassCleanup(lambda: sys.path.remove(str(source)))
        original_argv = sys.argv[:]
        try:
            sys.argv = [sys.argv[0], "--cpu"]
            import comfy.options
            comfy.options.enable_args_parsing()
            import comfy.latent_formats
            import comfy.model_sampling
            import nodes
            from comfy_extras.nodes_custom_sampler import BasicScheduler
        finally:
            sys.argv = original_argv
        cls.comfy, cls.nodes, cls.scheduler = comfy, nodes, BasicScheduler
        if comfy.model_management.get_torch_device().type != "cpu":
            raise RuntimeError("These adapter boundary tests must run on CPU.")

    def test_real_core_empty_latent_conversion_for_supported_families(self):
        requested = request(1)
        requested.update(width=64, height=64)
        for format_name, expected in (("Wan21", (1, 16, 1, 8, 8)), ("Flux", (1, 16, 8, 8)), ("SDXL", (1, 4, 8, 8))):
            latent_format = getattr(self.comfy.latent_formats, format_name)()
            model = types.SimpleNamespace(model=types.SimpleNamespace(latent_format=latent_format),
                                          get_model_object=lambda name: latent_format)
            initial = self.nodes.EmptyLatentImage().generate(64, 64, batch_size=1)[0]
            result = engine._prepare_input_latent(initial, model, requested)
            self.assertEqual(tuple(result["samples"].shape), expected)
            self.assertEqual(result["samples"].device.type, "cpu")

    def test_real_basic_scheduler_v3_output_is_accepted(self):
        sampling = self.comfy.model_sampling.ModelSamplingDiscrete()
        model = types.SimpleNamespace(get_model_object=lambda name: sampling)
        result = self.scheduler.execute(model=model, scheduler="normal", steps=8, denoise=1)
        schedule = engine._sigma_schedule(result[0])
        self.assertEqual(schedule["steps"], 8)
        self.assertEqual(schedule["end"], 0)

    def test_nonfloating_latent_is_rejected_before_core_conversion(self):
        for dtype in (real_torch.int64, real_torch.bool, real_torch.complex64):
            latent = {"samples": real_torch.zeros((1, 4, 8, 8), dtype=dtype)}
            with self.subTest(dtype=dtype), patch.object(self.comfy.sample, "fix_empty_latent_channels") as convert:
                with self.assertRaisesRegex(ValueError, "floating-point"):
                    engine._prepare_input_latent(latent, None, request(1))
                convert.assert_not_called()

    def test_real_comfy_sampler_choices_include_native_catalog(self):
        from dmai_nodes.presets import sampler_choices
        samplers, schedulers = sampler_choices()
        self.assertEqual(samplers, list(self.comfy.samplers.KSampler.SAMPLERS))
        self.assertEqual(schedulers, list(self.comfy.samplers.KSampler.SCHEDULERS))

    def test_progress_uses_the_real_comfy_registry_and_execution_context(self):
        from comfy_execution.graph import DynamicPrompt
        from comfy_execution.progress import ProgressRegistry
        from comfy_execution.utils import CurrentNodeContext
        from server import PromptServer
        from dmai_nodes.progress import GenerationProgress
        from dmai_nodes.nodes import DMAIGenerationEngine, io

        self.assertIn(io.Hidden.unique_id, DMAIGenerationEngine.define_schema().hidden)
        registry = ProgressRegistry("real-registry-job", DynamicPrompt({"engine-1": {"class_type": "DMAIGenerationEngine", "inputs": {}}}))
        events = []
        server = types.SimpleNamespace(client_id="real-client", send_sync=lambda *event: events.append(event))
        with patch("comfy_execution.progress.global_progress_registry", registry), \
             patch.object(PromptServer, "instance", server, create=True), \
             CurrentNodeContext("real-registry-job", "engine-1"):
            with GenerationProgress.from_comfy("engine-1") as progress:
                progress.configure(1, 4)
                progress.begin_sampling(0)
                registry.update_progress("engine-1", 2, 4)
                self.assertAlmostEqual(progress.fraction, 2 / 6)
                registry.update_progress("unrelated-node", 100, 100)
                self.assertAlmostEqual(progress.fraction, 2 / 6)
                progress.begin_decode()
                registry.update_progress("engine-1", 100, 100)
                self.assertAlmostEqual(progress.fraction, 4 / 6)
                progress.image_done()
            self.assertEqual(registry.handlers, {})
            registry.update_progress("engine-1", 0, 1)
        self.assertEqual(events[-1][1]["phase"], "complete")
        self.assertEqual(events[-1][2], "real-client")
        self.assertEqual(events[-1][1]["real_node_id"], "engine-1")

    def test_standalone_krea_enhancer_rejects_other_models_before_dependency(self):
        with patch.object(engine, "_enhancer_dependency") as dependency:
            with self.assertRaisesRegex(ValueError, "Krea 2 MODEL"):
                engine.apply_krea_enhancer(types.SimpleNamespace(model=object()))
            dependency.assert_not_called()


if __name__ == "__main__":
    unittest.main()
