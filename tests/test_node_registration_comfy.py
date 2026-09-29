"""Opt-in regression tests using ComfyUI's actual custom-node loader on CPU.

Legacy fixtures reproduce the standalone V1 and Suite V3 Prompter contracts;
no old package, model download, model execution or GPU is required. The new
extension is loaded from this checkout through its real entrypoint and routes.
"""

import json
import os
from pathlib import Path
import sys
import tempfile
import textwrap
import types
import unittest
from unittest.mock import patch


LEGACY_V1 = '''
class DMAIPrompter:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"clip": ("CLIP",), "prompt": ("STRING", {"multiline": True}),
                             "width": ("INT", {"default": 1024}), "height": ("INT", {"default": 1024})}}
    RETURN_TYPES = ("CONDITIONING", "INT", "INT", "STRING")
    RETURN_NAMES = ("conditioning", "width", "height", "positive_prompt")
    FUNCTION = "encode"
    CATEGORY = "DMAI/Prompting"

    def encode(self, clip, prompt, width, height):
        return (clip.encode_from_tokens_scheduled(clip.tokenize(prompt)), width, height, prompt)

NODE_CLASS_MAPPINGS = {"DMAIPrompter": DMAIPrompter}
NODE_DISPLAY_NAME_MAPPINGS = {"DMAIPrompter": "DMAI Prompter"}
'''

LEGACY_V3 = '''
from comfy_api.latest import ComfyExtension, io

class DMAIPrompter(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="DMAIPrompter", display_name="DMAI Prompter", category="DMAI Suite/Prompting",
            inputs=[io.Clip.Input("clip"), io.String.Input("prompt", default="", multiline=True),
                    io.Int.Input("width", default=1024), io.Int.Input("height", default=1024)],
            outputs=[io.Conditioning.Output(display_name="conditioning"), io.Int.Output(display_name="width"),
                     io.Int.Output(display_name="height"), io.String.Output(display_name="positive_prompt")])

    @classmethod
    def execute(cls, clip, prompt, width, height):
        return io.NodeOutput(clip.encode_from_tokens_scheduled(clip.tokenize(prompt)), width, height, prompt)

class LegacySuiteExtension(ComfyExtension):
    async def get_node_list(self):
        return [DMAIPrompter]

async def comfy_entrypoint():
    return LegacySuiteExtension()
'''


@unittest.skipUnless(os.environ.get("DMAI_RUN_COMFY_TESTS") == "1", "Opt-in real ComfyUI registration regression")
class RealComfyRegistrationTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.package = Path(__file__).resolve().parents[1]
        source = Path(os.environ.get("DMAI_COMFY_SOURCE", cls.package / ".validation" / "ComfyUI")).resolve()
        if not (source / "nodes.py").is_file():
            raise RuntimeError("Set DMAI_COMFY_SOURCE to an installed ComfyUI source checkout.")
        sys.path.insert(0, str(source))
        cls.addClassCleanup(lambda: sys.path.remove(str(source)))
        original_argv = sys.argv[:]
        try:
            sys.argv = [sys.argv[0], "--cpu"]
            import comfy.options
            comfy.options.enable_args_parsing()
            import comfy.model_management
            import nodes
            from server import PromptServer
            from aiohttp import web
            from dmai_nodes.nodes import DMAINodesPrompter
        finally:
            sys.argv = original_argv
        if comfy.model_management.get_torch_device().type != "cpu":
            raise RuntimeError("Registration regressions must run on CPU.")
        cls.nodes, cls.server, cls.web, cls.prompter = nodes, PromptServer, web, DMAINodesPrompter

    def setUp(self):
        # Restore native registries and module imports after every test. The
        # fixtures do not pollute other optional ComfyUI tests in the same run.
        for field in ("NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "LOADED_MODULE_DIRS", "EXTENSION_WEB_DIRS"):
            registry = getattr(self.nodes, field)
            guard = patch.dict(registry)
            guard.start()
            self.addCleanup(guard.stop)
        self.initial_modules = set(sys.modules)
        self.addCleanup(self._remove_loaded_package_modules)
        instance = types.SimpleNamespace(routes=self.web.RouteTableDef())
        guard = patch.object(self.server, "instance", instance, create=True)
        guard.start()
        self.addCleanup(guard.stop)
        self.temp = tempfile.TemporaryDirectory(prefix="dmai-coexistence-")
        self.addCleanup(self.temp.cleanup)

    def _remove_loaded_package_modules(self):
        for name in set(sys.modules) - self.initial_modules:
            if name.startswith((str(self.package).replace(".", "_x_"), self.temp.name.replace(".", "_x_"))):
                sys.modules.pop(name, None)

    async def _assert_coexistence(self, legacy_source, legacy_first):
        legacy = Path(self.temp.name) / "legacy_dmai"
        legacy.mkdir()
        (legacy / "__init__.py").write_text(textwrap.dedent(legacy_source), encoding="utf-8")
        order = (legacy, self.package) if legacy_first else (self.package, legacy)
        ignore = set(self.nodes.NODE_CLASS_MAPPINGS) - {"DMAIPrompter", "DMAINodesPrompter"}
        expected_ids = {"DMAINodesPrompter", "DMAILoRAStack", "DMAIGenerationEngine", "DMAIGallery",
                        "DMAIKreaEnhancer", "DMAIVAEEncode", "DMAIVAEDecode"}
        ignore.difference_update(expected_ids)
        for package in order:
            self.assertTrue(await self.nodes.load_custom_node(str(package), ignore=ignore), str(package))

        # The real loader must retain two separate classes/contracts even though
        # both node search labels intentionally remain "DMAI Prompter".
        new_node = self.nodes.NODE_CLASS_MAPPINGS["DMAINodesPrompter"]
        old_node = self.nodes.NODE_CLASS_MAPPINGS["DMAIPrompter"]
        self.assertIsNot(new_node, old_node)
        self.assertEqual(new_node.__name__, "DMAINodesPrompter")
        self.assertIn("DMAI-NODES", new_node.RELATIVE_PYTHON_MODULE)
        self.assertIn("legacy_dmai", old_node.RELATIVE_PYTHON_MODULE)
        self.assertEqual(tuple(new_node.RETURN_TYPES), ("DMAI_PROMPT",))
        self.assertEqual(tuple(old_node.RETURN_TYPES), ("CONDITIONING", "INT", "INT", "STRING"))
        self.assertTrue(expected_ids.issubset(self.nodes.NODE_CLASS_MAPPINGS))
        self.assertEqual(self.nodes.NODE_DISPLAY_NAME_MAPPINGS["DMAINodesPrompter"], "DMAI Prompter")
        self.assertEqual(self.nodes.NODE_DISPLAY_NAME_MAPPINGS["DMAIPrompter"], "DMAI Prompter")

        # Execute both loaded node classes through their published Comfy function
        # names; registry coexistence alone would not catch a wrong API contract.
        clip = types.SimpleNamespace(tokenize=lambda text: [text], encode_from_tokens_scheduled=lambda tokens: [tokens])
        old_result = getattr(old_node(), old_node.FUNCTION)(clip, "old workflow", 1024, 768)
        self.assertEqual(old_result[0], [["old workflow"]])
        self.assertEqual(tuple(old_result[index] for index in range(1, 4)), (1024, 768, "old workflow"))
        requested = {"schema_version": 1, "prompt": "new workflow", "negative_prompt": "blur",
                     "width": 832, "height": 1024, "count": 3}
        new_result = getattr(new_node(), new_node.FUNCTION)(json.dumps(requested), text="connected text")
        self.assertEqual(new_result[0], {**requested, "prompt": "connected text\nnew workflow"})

    async def test_legacy_standalone_loaded_before_new_extension(self):
        await self._assert_coexistence(LEGACY_V1, legacy_first=True)

    async def test_legacy_standalone_loaded_after_new_extension(self):
        await self._assert_coexistence(LEGACY_V1, legacy_first=False)

    async def test_legacy_suite_loaded_before_new_extension(self):
        await self._assert_coexistence(LEGACY_V3, legacy_first=True)

    async def test_legacy_suite_loaded_after_new_extension(self):
        await self._assert_coexistence(LEGACY_V3, legacy_first=False)

    async def test_new_extension_alone_does_not_claim_legacy_id(self):
        self.nodes.NODE_CLASS_MAPPINGS.pop("DMAIPrompter", None)
        self.nodes.NODE_DISPLAY_NAME_MAPPINGS.pop("DMAIPrompter", None)
        self.assertTrue(await self.nodes.load_custom_node(str(self.package)))
        self.assertNotIn("DMAIPrompter", self.nodes.NODE_CLASS_MAPPINGS)
        self.assertNotIn("DMAIPrompter", self.nodes.NODE_DISPLAY_NAME_MAPPINGS)
        self.assertIn("DMAINodesPrompter", self.nodes.NODE_CLASS_MAPPINGS)

    def test_prompter_schema_exposes_the_same_headless_request_contract(self):
        info = self.prompter.GET_NODE_INFO_V1()
        self.assertEqual(info["name"], "DMAINodesPrompter")
        self.assertEqual(info["display_name"], "DMAI Prompter")
        self.assertEqual(info["category"], "DMAI NODES")
        self.assertEqual(info["output"], ["DMAI_PROMPT"])
        self.assertEqual(info["output_name"], ["request"])
        self.assertEqual(set(info["input"]["required"]), {"config_json"})
        self.assertEqual(set(info["input"]["optional"]), {"text"})
        self.assertEqual(info["input"]["required"]["config_json"][0], "STRING")
        self.assertTrue(info["input"]["required"]["config_json"][1]["socketless"])
        self.assertEqual(info["input"]["optional"]["text"][0], "STRING")
        self.assertTrue(info["input"]["optional"]["text"][1]["forceInput"])

    def test_engine_schema_defaults_to_free_manual_settings(self):
        from dmai_nodes.nodes import DMAIGenerationEngine
        from dmai_nodes.engine import parse_engine_config

        info = DMAIGenerationEngine.GET_NODE_INFO_V1()
        config = json.loads(info["input"]["required"]["config_json"][1]["default"])
        self.assertEqual(config["mode"], "manual")
        self.assertEqual(config["preset_id"], "")
        self.assertEqual(config["presets"], [])
        self.assertEqual(config["settings"]["enhancer"], "none")
        self.assertEqual(parse_engine_config(config)["settings"], config["settings"])

    def test_prompter_json_and_optional_text_keep_validation(self):
        requested = {"schema_version": 1, "prompt": "  local prompt  ", "negative_prompt": "blur",
                     "width": 1536, "height": 1024, "count": 8}
        serialized = json.dumps(requested)
        self.assertEqual(self.prompter.execute(serialized)[0], requested)
        self.assertEqual(self.prompter.execute(serialized, "  upstream text  ")[0],
                         {**requested, "prompt": "upstream text\nlocal prompt"})
        self.assertEqual(json.loads(serialized), requested)
        for invalid in ({**requested, "count": 9}, {**requested, "width": 1001}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.prompter.execute(json.dumps(invalid))
        with self.assertRaisesRegex(ValueError, "must be strings"):
            self.prompter.execute(serialized, text=123)


if __name__ == "__main__":
    unittest.main()
