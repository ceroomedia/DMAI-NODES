"""CPU-only contract tests for ordered LoRA loading and accurate reporting.

Comfy interfaces are isolated here. These tests establish catalog, validation,
ordering and registration behavior; they do not claim real-model GPU coverage.
"""

import copy
import json
import logging
import os
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

from dmai_nodes.lora import (
    MAX_ENTRIES, MAX_MANIFEST_BYTES, apply_loras, fingerprint_manifest,
    list_loras, parse_manifest, validate_manifest_files,
)


def entry(name="style.safetensors", *, identifier="entry-1", enabled=True, model=1, clip=1):
    return {"id": identifier, "name": name, "enabled": enabled, "strength_model": model, "strength_clip": clip}


def manifest(*entries):
    return {"schema_version": 1, "entries": list(entries)}


class Patcher:
    def __init__(self, keys=("model.weight",), patches=None):
        self.keys = set(keys)
        self.patches = {} if patches is None else patches

    def clone(self):
        return Patcher(self.keys, {key: values[:] for key, values in self.patches.items()})

    def add_patches(self, weights, strength):
        loaded = []
        for key, weight in weights.items():
            if key in self.keys:
                self.patches.setdefault(key, []).append((strength, weight))
                loaded.append(key)
        return loaded


class Clip:
    def __init__(self, patcher=None):
        self.patcher = patcher or Patcher(("clip.weight",))

    def clone(self):
        return Clip(self.patcher.clone())

    def add_patches(self, weights, strength):
        return self.patcher.add_patches(weights, strength)


class ManifestTests(unittest.TestCase):
    def test_normalization_preserves_order_case_values_and_source(self):
        value = manifest(entry(r"Styles\Film.safetensors"), entry("styles/film.safetensors", identifier="two", model=-0.5, clip=0))
        original = copy.deepcopy(value)
        parsed = parse_manifest(json.dumps(value))
        self.assertEqual([x["name"] for x in parsed["entries"]], ["Styles/Film.safetensors", "styles/film.safetensors"])
        self.assertEqual(parsed["entries"][1]["strength_model"], -0.5)
        parsed["entries"][0]["enabled"] = False
        self.assertEqual(value, original)

    def test_disabled_boolean_is_preserved_but_false_string_and_numbers_rejected(self):
        self.assertFalse(parse_manifest(manifest(entry(enabled=False)))["entries"][0]["enabled"])
        for value in ("false", "true", 0, 1, None, []):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "enabled"):
                parse_manifest(manifest(entry(enabled=value)))

    def test_strict_json_errors_and_no_unknown_or_missing_fields(self):
        for value in ("{", "[]", "null", None, [], {}, {"schema_version": 1, "entries": [], "script": "x"}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_manifest(value)
        invalid = entry()
        invalid["path"] = "/tmp/model"
        with self.assertRaises(ValueError):
            parse_manifest(manifest(invalid))
        del invalid["path"]
        del invalid["strength_clip"]
        with self.assertRaises(ValueError):
            parse_manifest(manifest(invalid))

    def test_duplicate_json_keys_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            parse_manifest('{"schema_version":1,"entries":[],"entries":[]}')
        text = json.dumps(manifest(entry())).replace('"enabled": true', '"enabled": false, "enabled": true')
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            parse_manifest(text)

    def test_numeric_contract_rejects_boolean_nonfinite_and_excessive_strengths(self):
        for value in (True, False, "1", float("nan"), float("inf"), -21, 20.01, 10**1000):
            with self.subTest(value=type(value).__name__), self.assertRaises(ValueError):
                parse_manifest(manifest(entry(model=value)))
        for value in ("NaN", "Infinity", "-Infinity", "1e999"):
            text = json.dumps(manifest(entry())).replace('"strength_model": 1', '"strength_model": ' + value)
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_manifest(text)
        self.assertEqual(parse_manifest(manifest(entry(model=-20, clip=20)))["entries"][0]["strength_clip"], 20)

    def test_versions_entry_ids_and_limits_are_strict(self):
        for version in (True, "1", 1.0, 2):
            with self.subTest(version=version), self.assertRaises(ValueError):
                parse_manifest({"schema_version": version, "entries": []})
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            parse_manifest(manifest(entry(), entry()))
        for identifier in ("", "a/b", "../x", "x" * 129):
            with self.subTest(identifier=identifier), self.assertRaises(ValueError):
                parse_manifest(manifest(entry(identifier=identifier)))
        with self.assertRaisesRegex(ValueError, "64"):
            parse_manifest(manifest(*[entry(identifier=str(index)) for index in range(MAX_ENTRIES + 1)]))
        with self.assertRaisesRegex(ValueError, "128 KiB"):
            parse_manifest(" " * (MAX_MANIFEST_BYTES + 1))

    def test_utf8_byte_limit_also_applies_to_dict_input(self):
        value = manifest(*[entry("🎨" * 700 + ".safetensors", identifier=str(index)) for index in range(64)])
        with self.assertRaisesRegex(ValueError, "128 KiB"):
            parse_manifest(value)

    def test_absolute_traversal_and_control_character_paths_rejected(self):
        for name in ("/model.safetensors", r"C:\model.safetensors", r"\\host\model", "../x", "a/../x", "./x", "a//x", "a/", "a\x00x", "a\nfile", "a\u202efile", ""):
            with self.subTest(name=name), self.assertRaises(ValueError):
                parse_manifest(manifest(entry(name)))


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.names = []
        self.files = {}
        self.weights = {}
        self.file_loads = []
        self.lora_loads = []
        self.resolutions = []
        self.warnings = []
        folder = types.ModuleType("folder_paths")
        folder.get_filename_list = lambda category: self.names[:]

        def resolve(category, name):
            self.assertEqual(category, "loras")
            self.resolutions.append(name)
            return str(self.files[name])

        folder.get_full_path_or_raise = resolve
        comfy = types.ModuleType("comfy")
        sd, utils = types.ModuleType("comfy.sd"), types.ModuleType("comfy.utils")
        comfy.sd, comfy.utils = sd, utils

        def load_file(path, *, safe_load, return_metadata):
            self.assertTrue(safe_load)
            self.assertTrue(return_metadata)
            self.file_loads.append(path)
            return self.weights[path], {"source": "test"}

        def load_lora(model, clip, weights, strength_model, strength_clip, *, lora_metadata):
            self.lora_loads.append((weights, strength_model, strength_clip, lora_metadata))
            model = model.clone() if model is not None else None
            clip = clip.clone() if clip is not None else None
            loaded = set(model.add_patches(weights, strength_model)) if model else set()
            loaded |= set(clip.add_patches(weights, strength_clip)) if clip else set()
            for key in weights:
                if key not in loaded:
                    logging.warning("NOT LOADED %s", key)
            for message in self.warnings:
                logging.warning(message)
            return model, clip

        utils.load_torch_file = load_file
        sd.load_lora_for_models = load_lora
        self.sd, self.utils = sd, utils
        modules = patch.dict(sys.modules, {"folder_paths": folder, "comfy": comfy, "comfy.sd": sd, "comfy.utils": utils})
        modules.start()
        self.addCleanup(modules.stop)

    def add_file(self, name="style.safetensors", weights=None, data=b"first"):
        path = self.root / f"file-{len(self.files)}.safetensors"
        path.write_bytes(data)
        self.names.append(name)
        self.files[name] = path
        self.weights[str(path)] = {"model.weight": 1} if weights is None else weights
        return path

    def test_catalog_maps_windows_separators_back_to_exact_native_filename(self):
        self.add_file(r"styles\Film.safetensors")
        listed = list_loras()
        self.assertEqual(listed[0]["name"], "styles/Film.safetensors")
        self.assertEqual(set(listed[0]), {"id", "name"})
        apply_loras(Patcher(), Clip(), manifest(entry("styles/Film.safetensors")))
        self.assertEqual(self.resolutions, [r"styles\Film.safetensors"])
        self.assertNotIn(str(self.root), json.dumps(listed))

    def test_catalog_ids_preserve_case_and_are_stable_across_separators(self):
        self.add_file("Film.safetensors")
        self.add_file("film.safetensors")
        self.add_file(r"styles\Film.safetensors")
        listed = list_loras()
        self.assertEqual(len({item["id"] for item in listed}), 3)
        self.names[-1] = "styles/Film.safetensors"
        self.assertEqual(listed, list_loras())

    def test_exact_case_required_even_on_windows_and_missing_names_never_resolved(self):
        self.add_file("Film.safetensors")
        for name in ("film.safetensors", "missing.safetensors"):
            with self.subTest(name=name), self.assertRaises(FileNotFoundError):
                validate_manifest_files(manifest(entry(name)))
        self.assertEqual(self.resolutions, [])
        self.assertEqual(self.file_loads, [])

    def test_ambiguous_native_names_fail_instead_of_loading_arbitrary_file(self):
        self.add_file(r"styles\Film.safetensors")
        self.add_file("styles/Film.safetensors")
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            list_loras()

    def test_missing_second_file_preflights_before_first_tensor_load(self):
        self.add_file()
        with self.assertRaises(FileNotFoundError):
            apply_loras(Patcher(), Clip(), manifest(entry(), entry("missing.safetensors", identifier="two")))
        self.assertEqual(self.file_loads, [])

    def test_disabled_and_zero_strength_entries_are_distinct_and_need_no_file(self):
        model, clip = Patcher(), Clip()
        next_model, next_clip, reports = apply_loras(model, clip, manifest(entry(enabled=False), entry("zero.safetensors", identifier="zero", model=0, clip=0)))
        self.assertIs(model, next_model)
        self.assertIs(clip, next_clip)
        self.assertEqual([report["status"] for report in reports], ["disabled", "zero_strength"])
        self.assertEqual(self.file_loads, [])
        self.assertEqual(self.resolutions, [])

    def test_call_order_and_separate_strengths_preserved_with_existing_patches(self):
        self.add_file("first.safetensors", {"model.weight": "first", "clip.weight": "first"})
        self.add_file("second.safetensors", {"model.weight": "second", "clip.weight": "second"})
        source_model = Patcher(patches={"model.weight": [(0.1, "existing")]})
        recipe = manifest(entry("second.safetensors", model=-0.5, clip=0.25), entry("first.safetensors", identifier="two", model=0.8, clip=1.2))
        model, clip, reports = apply_loras(source_model, Clip(), recipe)
        self.assertEqual([call[1:3] for call in self.lora_loads], [(-0.5, 0.25), (0.8, 1.2)])
        self.assertEqual([value[1] for value in model.patches["model.weight"]], ["existing", "second", "first"])
        self.assertEqual([value[0] for value in clip.patcher.patches["clip.weight"]], [0.25, 1.2])
        self.assertEqual(source_model.patches, {"model.weight": [(0.1, "existing")]})
        self.assertEqual([r["model_patches"] for r in reports], [1, 1])
        self.assertEqual([r["clip_patches"] for r in reports], [1, 1])
        self.assertTrue(all(r["status"] == "loaded" and r["verification"] == "registered_patches" for r in reports))
        self.assertTrue(all(call[3] == {"source": "test"} for call in self.lora_loads))

    def test_duplicate_files_with_unique_ids_are_intentionally_applied_twice(self):
        self.add_file()
        model, _, reports = apply_loras(Patcher(), Clip(), manifest(entry(), entry(identifier="two")))
        self.assertEqual(len(model.patches["model.weight"]), 2)
        self.assertEqual(len(reports), 2)
        self.assertEqual(len(self.file_loads), 2)

    def test_zero_strength_target_does_not_count_as_effective_match(self):
        self.add_file(weights={"model.weight": "model only"})
        with self.assertRaisesRegex(ValueError, "no nonzero matching"):
            apply_loras(Patcher(), Clip(), manifest(entry(model=0, clip=1)))
        self.lora_loads.clear()
        model, clip, reports = apply_loras(Patcher(), Clip(), manifest(entry(model=1, clip=0)))
        self.assertEqual(reports[0]["model_patches"], 1)
        self.assertEqual(reports[0]["clip_patches"], 0)

    def test_model_only_and_clip_only_calls_are_supported(self):
        self.add_file("model.safetensors", {"model.weight": "m"})
        self.add_file("clip.safetensors", {"clip.weight": "c"})
        model, clip, reports = apply_loras(Patcher(), None, manifest(entry("model.safetensors", clip=0)))
        self.assertIsNone(clip)
        self.assertEqual(reports[0]["model_patches"], 1)
        model, clip, reports = apply_loras(None, Clip(), manifest(entry("clip.safetensors", model=0)))
        self.assertIsNone(model)
        self.assertEqual(reports[0]["clip_patches"], 1)

    def test_no_matching_patches_fails_instead_of_reporting_function_call_as_success(self):
        self.add_file(weights={"other.model.weight": 1})
        with self.assertRaisesRegex(ValueError, "no nonzero matching"):
            apply_loras(Patcher(), Clip(), manifest(entry()))
        self.assertEqual(len(self.lora_loads), 1)

    def test_partial_match_reports_both_standard_comfy_diagnostic_forms(self):
        self.add_file(weights={"model.weight": 1, "unknown.weight": 2})
        self.warnings = ["lora key not loaded: adapter.orphan"]
        _, _, reports = apply_loras(Patcher(), Clip(), manifest(entry()))
        self.assertEqual(reports[0]["status"], "partial")
        self.assertEqual(reports[0]["unmatched_count"], 2)
        self.assertEqual(reports[0]["unmatched_keys"], ["unknown.weight", "adapter.orphan"])
        self.assertEqual(reports[0]["model_patches"], 1)

    def test_diagnostic_capture_is_bounded_and_does_not_leak_handlers(self):
        self.add_file()
        self.warnings = ["lora key not loaded: " + str(index) + "x" * 600 for index in range(75)]
        before = list(logging.getLogger().handlers)
        _, _, reports = apply_loras(Patcher(), Clip(), manifest(entry()))
        self.assertEqual(reports[0]["unmatched_count"], 75)
        self.assertEqual(len(reports[0]["unmatched_keys"]), 50)
        self.assertTrue(all(len(key) <= 512 for key in reports[0]["unmatched_keys"]))
        self.assertEqual(logging.getLogger().handlers, before)

    def test_logs_from_other_execution_threads_do_not_contaminate_report(self):
        self.add_file()
        original = self.sd.load_lora_for_models

        def other_thread_log(*args, **kwargs):
            worker = threading.Thread(target=lambda: logging.warning("NOT LOADED unrelated.weight"))
            worker.start()
            worker.join()
            return original(*args, **kwargs)

        self.sd.load_lora_for_models = other_thread_log
        _, _, reports = apply_loras(Patcher(), Clip(), manifest(entry()))
        self.assertEqual(reports[0]["status"], "loaded")
        self.assertEqual(reports[0]["unmatched_count"], 0)

    def test_unverifiable_patch_storage_fails_before_loading(self):
        self.add_file()
        with self.assertRaisesRegex(RuntimeError, "patch counts"):
            apply_loras(object(), Clip(), manifest(entry()))
        self.assertEqual(self.file_loads, [])

    def test_loader_exception_does_not_leave_logging_handler_attached(self):
        self.add_file()
        self.sd.load_lora_for_models = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("broken tensor"))
        before = list(logging.getLogger().handlers)
        with self.assertRaisesRegex(RuntimeError, "broken tensor"):
            apply_loras(Patcher(), Clip(), manifest(entry()))
        self.assertEqual(logging.getLogger().handlers, before)

    def test_fingerprint_tracks_replacement_even_with_same_size_and_mtime(self):
        path = self.add_file(data=b"first")
        recipe = manifest(entry())
        before = fingerprint_manifest(recipe)
        original_stat = path.stat()
        path.write_bytes(b"other")
        os.utime(path, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
        after = fingerprint_manifest(recipe)
        self.assertNotEqual(before, after)
        self.assertEqual(after, fingerprint_manifest(json.dumps(recipe)))

    def test_fingerprint_changes_with_order_strength_enabled_but_ignores_unused_files(self):
        self.add_file()
        unused = self.add_file("unused.safetensors")
        first = manifest(entry(), entry("unused.safetensors", identifier="two", enabled=False))
        expected = fingerprint_manifest(first)
        unused.write_bytes(b"newunused")
        self.assertEqual(expected, fingerprint_manifest(first))
        reversed_recipe = manifest(*list(reversed(first["entries"])))
        self.assertNotEqual(expected, fingerprint_manifest(reversed_recipe))
        changed_strength = copy.deepcopy(first)
        changed_strength["entries"][0]["strength_model"] = 0.5
        self.assertNotEqual(expected, fingerprint_manifest(changed_strength))
        self.assertEqual(self.file_loads, [])

    def test_preflight_detects_deleted_catalog_file(self):
        path = self.add_file()
        path.unlink()
        with self.assertRaisesRegex(FileNotFoundError, "unavailable"):
            validate_manifest_files(manifest(entry()))

    def test_file_changed_during_read_or_load_fails_cleanly(self):
        self.add_file()
        with patch("dmai_nodes.lora._stat_signature", side_effect=[(1, 1, 1, 1), (1, 2, 1, 1)]):
            with self.assertRaisesRegex(ValueError, "changed while fingerprinting"):
                fingerprint_manifest(manifest(entry()))
        with patch("dmai_nodes.lora._stat_signature", side_effect=[(1, 1, 1, 1), (1, 2, 1, 1)]):
            with self.assertRaisesRegex(ValueError, "changed while loading"):
                apply_loras(Patcher(), Clip(), manifest(entry()))
        self.assertEqual(self.lora_loads, [])


if __name__ == "__main__":
    unittest.main()
