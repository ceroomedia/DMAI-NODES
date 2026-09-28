"""Opt-in comparison against real ComfyUI using tiny CPU tensors only.

Set DMAI_RUN_COMFY_TESTS=1 and optionally DMAI_COMFY_SOURCE. No model weights
are downloaded. The default source is .validation/ComfyUI inside this checkout.
Ordinary unit discovery skips these tests without that explicit environment flag.
"""

import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from dmai_nodes.lora import apply_loras


@unittest.skipUnless(os.environ.get("DMAI_RUN_COMFY_TESTS") == "1", "Opt-in real ComfyUI CPU comparison")
class RealComfyLoraTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = Path(os.environ.get("DMAI_COMFY_SOURCE", Path(__file__).resolve().parents[1] / ".validation" / "ComfyUI")).resolve()
        if not (source / "comfy" / "sd.py").is_file():
            raise RuntimeError("Set DMAI_COMFY_SOURCE to an installed ComfyUI source checkout.")
        sys.path.insert(0, str(source))
        cls.addClassCleanup(lambda: sys.path.remove(str(source)))
        old_argv = sys.argv[:]
        try:
            sys.argv = [sys.argv[0], "--cpu"]
            import comfy.options
            comfy.options.enable_args_parsing()
            import comfy.sd
            import comfy.lora
            import comfy.model_patcher
            import folder_paths
            import torch
            from safetensors.torch import save_file
        finally:
            sys.argv = old_argv
        cls.torch, cls.comfy, cls.folder_paths, cls.save_file = torch, comfy, folder_paths, staticmethod(save_file)
        if comfy.model_management.get_torch_device().type != "cpu":
            raise RuntimeError("This tiny-tensor test must run on the CPU.")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.files = {}
        self.catalog = patch.object(self.folder_paths, "get_filename_list", lambda category: list(self.files))
        self.resolver = patch.object(self.folder_paths, "get_full_path_or_raise", lambda category, name: str(self.files[name]))
        self.catalog.start()
        self.resolver.start()
        self.addCleanup(self.catalog.stop)
        self.addCleanup(self.resolver.stop)

    def model(self):
        torch = self.torch
        module = torch.nn.Module()
        module.diffusion_model = torch.nn.Module()
        module.diffusion_model.linear = torch.nn.Linear(2, 2, bias=False)
        module.diffusion_model.linear.weight.data.fill_(1.0)
        module.model_config = types.SimpleNamespace(unet_config={})
        return self.comfy.model_patcher.ModelPatcher(module, torch.device("cpu"), torch.device("cpu"))

    def clip(self):
        torch, patcher_type = self.torch, self.comfy.model_patcher.ModelPatcher

        class TinyClip:
            def __init__(self, patcher=None):
                if patcher is None:
                    module = torch.nn.Module()
                    module.linear = torch.nn.Linear(2, 2, bias=False)
                    module.linear.weight.data.fill_(2.0)
                    patcher = patcher_type(module, torch.device("cpu"), torch.device("cpu"))
                self.patcher = patcher
                self.cond_stage_model = patcher.model

            def clone(self):
                return TinyClip(self.patcher.clone())

            def add_patches(self, weights, strength):
                return self.patcher.add_patches(weights, strength)

        return TinyClip()

    def fixture(self, name="tiny.safetensors", factor=1.0, include_clip=True, orphan=False):
        torch = self.torch
        up = torch.tensor([[1.0], [2.0]]) * factor
        down = torch.tensor([[3.0, 4.0]])
        weights = {
            "lora_unet_linear.lora_up.weight": up,
            "lora_unet_linear.lora_down.weight": down,
            "lora_unet_linear.alpha": torch.tensor(1.0),
        }
        if include_clip:
            weights.update({
                "text_encoders.linear.lora_up.weight": up * 2,
                "text_encoders.linear.lora_down.weight": down.clone(),
                "text_encoders.linear.alpha": torch.tensor(1.0),
            })
        if orphan:
            weights["unrecognized.adapter.weight"] = torch.ones((1, 1))
        target = self.root / name
        self.save_file(weights, str(target), metadata={"test": "tiny CPU adapter"})
        self.files[name] = target
        return weights, up @ down

    def recipe(self, *items):
        return {"schema_version": 1, "entries": [
            {"id": f"entry-{index}", "name": name, "enabled": True, "strength_model": model, "strength_clip": clip}
            for index, (name, model, clip) in enumerate(items)
        ]}

    def evaluate(self, patcher, key):
        weight = patcher.model.state_dict()[key].clone()
        return self.comfy.lora.calculate_weight(patcher.patches.get(key, []), weight, key)

    def test_real_loader_matches_standard_and_expected_model_and_clip_math(self):
        weights, delta = self.fixture()
        model, clip = self.model(), self.clip()
        actual_model, actual_clip, report = apply_loras(model, clip, self.recipe(("tiny.safetensors", 0.5, -0.25)))
        expected_model, expected_clip = self.comfy.sd.load_lora_for_models(model, clip, weights, 0.5, -0.25)
        actual = self.evaluate(actual_model, "diffusion_model.linear.weight")
        actual_text = self.evaluate(actual_clip.patcher, "linear.weight")
        self.torch.testing.assert_close(actual, self.evaluate(expected_model, "diffusion_model.linear.weight"), rtol=0, atol=0)
        self.torch.testing.assert_close(actual_text, self.evaluate(expected_clip.patcher, "linear.weight"), rtol=0, atol=0)
        self.torch.testing.assert_close(actual, self.torch.ones((2, 2)) + 0.5 * delta, rtol=0, atol=0)
        self.torch.testing.assert_close(actual_text, self.torch.full((2, 2), 2.0) - 0.5 * delta, rtol=0, atol=0)
        self.assertEqual((report[0]["status"], report[0]["model_patches"], report[0]["clip_patches"]), ("loaded", 1, 1))
        self.assertEqual(model.patches, {})
        self.assertEqual(clip.patcher.patches, {})

    def test_real_loader_preserves_multiple_adapter_order_and_separate_strengths(self):
        first, _ = self.fixture("first.safetensors", factor=1)
        second, _ = self.fixture("second.safetensors", factor=3)
        model, clip = self.model(), self.clip()
        recipe = self.recipe(("second.safetensors", -0.25, 0.75), ("first.safetensors", 0.5, 0.125))
        actual_model, actual_clip, report = apply_loras(model, clip, recipe)
        expected_model, expected_clip = self.comfy.sd.load_lora_for_models(model, clip, second, -0.25, 0.75)
        expected_model, expected_clip = self.comfy.sd.load_lora_for_models(expected_model, expected_clip, first, 0.5, 0.125)
        self.torch.testing.assert_close(self.evaluate(actual_model, "diffusion_model.linear.weight"), self.evaluate(expected_model, "diffusion_model.linear.weight"), rtol=0, atol=0)
        self.torch.testing.assert_close(self.evaluate(actual_clip.patcher, "linear.weight"), self.evaluate(expected_clip.patcher, "linear.weight"), rtol=0, atol=0)
        self.assertEqual([p[0] for p in actual_model.patches["diffusion_model.linear.weight"]], [-0.25, 0.5])
        self.assertEqual([p[0] for p in actual_clip.patcher.patches["linear.weight"]], [0.75, 0.125])
        self.assertEqual([item["name"] for item in report], ["second.safetensors", "first.safetensors"])

    def test_real_comfy_unmatched_diagnostic_produces_partial_report(self):
        self.fixture(orphan=True)
        _, _, report = apply_loras(self.model(), self.clip(), self.recipe(("tiny.safetensors", 1, 1)))
        self.assertEqual(report[0]["status"], "partial")
        self.assertEqual(report[0]["unmatched_keys"], ["unrecognized.adapter.weight"])

    def test_real_comfy_zero_effective_match_is_an_error(self):
        self.fixture(include_clip=False)
        with self.assertRaisesRegex(ValueError, "no nonzero matching"):
            apply_loras(self.model(), self.clip(), self.recipe(("tiny.safetensors", 0, 1)))


if __name__ == "__main__":
    unittest.main()
