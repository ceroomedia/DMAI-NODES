"""Data boundary tests; these do not establish GPU or image-quality compatibility."""
from copy import deepcopy
import json
import unittest

from dmai_nodes.presets import get_builtin_presets, parse_preset_file, resolve_preset


class PresetTests(unittest.TestCase):
    def setUp(self):
        self.preset = get_builtin_presets()[0]

    def test_reference_settings_and_roundtrip(self):
        self.assertEqual(self.preset["settings"], {"steps": 8, "cfg": 1.1, "sampler": "euler", "scheduler": "beta", "denoise": 1, "enhancer": "krea2t"})
        self.assertEqual(parse_preset_file(json.dumps(self.preset)), [self.preset])

    def test_strict_keys_and_values(self):
        mutations = [lambda p: p.update(url="https://example.test"), lambda p: p.update(schema_version=True),
                     lambda p: p["settings"].update(steps=True), lambda p: p["settings"].update(cfg="1.1"),
                     lambda p: p["settings"].update(steps=151), lambda p: p["settings"].update(cfg=float("nan")),
                     lambda p: p["settings"].update(sampler="unknown"), lambda p: p["settings"].update(enhancer="script"),
                     lambda p: p.update(trusted=True), lambda p: p.update(name="<script>bad</script>"),
                     lambda p: p["model"].update(label="Another model"), lambda p: p["model"].update(id="unregistered")]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                item = deepcopy(self.preset)
                mutate(item)
                with self.assertRaises(ValueError):
                    parse_preset_file(item)

    def test_duplicate_prototype_and_oversized_json(self):
        for value in ('{"id":"a","id":"b"}', '{"constructor":{}}', " " * 131073,
                      '{"schema_version":NaN}', "[1,2]", "not json"):
            with self.subTest(value=value[:30]):
                with self.assertRaises(ValueError):
                    parse_preset_file(value)

    def test_pack_atomic_validation(self):
        other = deepcopy(self.preset)
        other["id"] = "my-settings-v1"
        pack = {"schema_version": 1, "presets": [self.preset, other]}
        self.assertEqual(len(parse_preset_file(pack)), 2)
        other["settings"]["steps"] = 0
        with self.assertRaises(ValueError):
            parse_preset_file(pack)
        for entries in ([], [self.preset] * 21, [self.preset, self.preset]):
            with self.assertRaises(ValueError):
                parse_preset_file({"schema_version": 1, "presets": entries})

    def test_model_specific_enhancement(self):
        sdxl = get_builtin_presets()[2]
        sdxl["settings"]["enhancer"] = "krea2t"
        with self.assertRaises(ValueError):
            parse_preset_file(sdxl)

    def test_provenance_and_builtin_ids(self):
        imported = deepcopy(self.preset)
        imported["id"] = "my-settings-v1"
        imported["name"] = "DMAI Original"
        result, source = resolve_preset(imported["id"], "krea2-turbo", [imported])
        self.assertEqual(source, "imported")
        self.assertEqual(result, imported)
        with self.assertRaises(ValueError):
            resolve_preset(self.preset["id"], "krea2-turbo", [self.preset])
        with self.assertRaises(ValueError):
            resolve_preset(imported["id"], "sdxl-checkpoint", [imported])


if __name__ == "__main__":
    unittest.main()
