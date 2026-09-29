"""Conservative migration: new-package Prompters move; legacy graphs stay intact."""
from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools import migrate_workflow as migration
from tools import run_workflow


ROOT = Path(__file__).resolve().parents[1]


def config(**updates):
    value = {"schema_version": 1, "prompt": "A green glass sculpture", "negative_prompt": "",
             "width": 832, "height": 1024, "count": 1}
    value.update(updates)
    return json.dumps(value)


def ui_node(node_id=1):
    return {"id": node_id, "type": "DMAIPrompter", "pos": [45, 90],
            "inputs": [{"name": "text", "type": "STRING", "link": None}],
            "outputs": [{"name": "request", "type": "DMAI_PROMPT", "slot_index": 0, "links": [12]}],
            "widgets_values": [config()], "properties": {"Node name for S&R": "DMAIPrompter"}}


def api_graph():
    return {"1": {"class_type": "DMAIPrompter", "inputs": {"config_json": config()}},
            "3": {"class_type": "DMAIGenerationEngine", "inputs": {"request": ["1", 0]}}}


class WorkflowMigrationTests(unittest.TestCase):
    def test_mixed_ui_nodes_and_links_are_preserved(self):
        new = ui_node()
        legacy = {"id": 2, "type": "DMAIPrompter", "inputs": [{"name": "clip", "type": "CLIP", "link": 4}],
                  "outputs": [{"name": "conditioning", "type": "CONDITIONING"}],
                  "widgets_values": ["Original prompt", 1024, 1024]}
        ambiguous = {"id": 3, "type": "DMAIPrompter", "widgets_values": [config()]}
        document = {"nodes": [new, legacy, ambiguous], "links": [[12, 1, 0, 5, 0, "DMAI_PROMPT"]]}
        before = deepcopy(document)
        result, report = migration.migrate_workflow(document)
        expected = deepcopy(document)
        expected["nodes"][0]["type"] = "DMAINodesPrompter"
        expected["nodes"][0]["properties"]["Node name for S&R"] = "DMAINodesPrompter"
        self.assertEqual(result, expected)
        self.assertEqual(document, before)
        self.assertEqual(len(report["migrated"]), 1)
        self.assertEqual(len(report["preserved"]), 2)
        self.assertEqual(migration.migrate_workflow(result)[0], result)
        self.assertEqual(migration.migrate_workflow(result)[1]["migrated"], [])

    def test_current_named_widget_save_and_dual_save(self):
        node = ui_node()
        raw = node.pop("widgets_values")[0]
        node["widgets_values_named"] = {"config_json": raw}
        self.assertEqual(len(migration.migrate_workflow({"nodes": [node]})[1]["migrated"]), 1)
        node["widgets_values"] = [json.dumps(dict(reversed(list(json.loads(raw).items()))))]
        self.assertEqual(len(migration.migrate_workflow({"nodes": [node]})[1]["migrated"]), 1)
        node["widgets_values"] = [config(prompt="A different saved prompt")]
        self.assertEqual(migration.migrate_workflow({"nodes": [node]})[0], {"nodes": [node]})

    def test_ambiguous_ui_signatures_are_unchanged(self):
        cases = [
            lambda n: n["inputs"].append({"name": "clip", "type": "CLIP"}),
            lambda n: n["inputs"].append(deepcopy(n["inputs"][0])),
            lambda n: n["outputs"].append({"name": "width", "type": "INT"}),
            lambda n: n["outputs"][0].update(slot_index=True),
            lambda n: n["outputs"][0].update(name="conditioning"),
            lambda n: n.update(widgets_values=[config(), "another widget"]),
            lambda n: n.update(widgets_values_named={"config_json": config(), "clip": "legacy"}),
            lambda n: n.update(widgets_values_named={"config_json": "not json"}),
            lambda n: n.update(inputs={"text": "STRING"}),
        ]
        for mutate in cases:
            node = ui_node()
            mutate(node)
            with self.subTest(node=node):
                document = {"nodes": [node]}
                self.assertEqual(migration.migrate_workflow(document)[0], document)

    def test_invalid_or_legacy_config_is_not_migrated(self):
        invalid = [config(clip="legacy"), config(schema_version=True), config(count=True), config(count=9),
                   config(width=65), config(width=8192, height=8192), config(prompt=123),
                   config(prompt="bad\x00text"), config(prompt="x" * 65537), '{"schema_version":1}',
                   config().replace('"count": 1', '"count": 1, "count": 2'),
                   config().replace('"count": 1', '"count": NaN')]
        for raw in invalid:
            with self.subTest(raw=raw[:90]):
                node = ui_node()
                node["widgets_values"] = [raw]
                self.assertEqual(migration.migrate_workflow({"nodes": [node]})[0], {"nodes": [node]})
                graph = api_graph()
                graph["1"]["inputs"]["config_json"] = raw
                self.assertEqual(migration.migrate_workflow(graph)[0], graph)

    def test_mixed_api_graph_only_migrates_typed_engine_request(self):
        graph = api_graph()
        graph["2"] = {"class_type": "DMAIPrompter", "inputs": {"clip": ["5", 1], "prompt": "Keep me", "width": 1024, "height": 1024}}
        graph["4"] = {"class_type": "DMAIPrompter", "inputs": {"config_json": config()}}
        before = deepcopy(graph)
        result, report = migration.migrate_workflow(graph)
        expected = deepcopy(graph)
        expected["1"]["class_type"] = "DMAINodesPrompter"
        self.assertEqual(result, expected)
        self.assertEqual(graph, before)
        self.assertEqual(len(report["migrated"]), 1)
        self.assertEqual(len(report["preserved"]), 2)

    def test_wrong_api_links_and_legacy_inputs_are_unchanged(self):
        cases = [lambda g: g["3"]["inputs"].update(request=["1", 1]),
                 lambda g: g["3"]["inputs"].update(request=["1", False]),
                 lambda g: g["3"]["inputs"].update(request=["99", 0]),
                 lambda g: g["3"].update(class_type="OtherEngine"),
                 lambda g: g["3"]["inputs"].update({"clip": g["3"]["inputs"].pop("request")}),
                 lambda g: g["1"]["inputs"].update(clip=["9", 1]),
                 lambda g: g.update({"4": {"class_type": "OtherNode", "inputs": {"width": ["1", 1]}}}),
                 lambda g: g.update({"4": {"class_type": "OtherNode", "inputs": {"width": ["1", "1"]}}})]
        for mutate in cases:
            graph = api_graph()
            mutate(graph)
            with self.subTest(graph=graph):
                self.assertEqual(migration.migrate_workflow(graph)[0], graph)

    def test_nested_serialized_subgraphs_and_api_wrapper(self):
        nested = {"nodes": [ui_node(9)], "definitions": {"subgraphs": [{"nodes": [ui_node(10)]}]}}
        document = {"prompt": api_graph(), "extra_data": {"extra_pnginfo": {"workflow": {
            "nodes": [ui_node()], "definitions": {"subgraphs": [nested]},
            "extra": {"example": {"nodes": [ui_node(88)]}}
        }}}}
        result, report = migration.migrate_workflow(document)
        self.assertEqual(len(report["migrated"]), 4)
        self.assertEqual(result["prompt"]["1"]["class_type"], "DMAINodesPrompter")
        workflow = result["extra_data"]["extra_pnginfo"]["workflow"]
        self.assertEqual(workflow["definitions"]["subgraphs"][0]["nodes"][0]["type"], "DMAINodesPrompter")
        self.assertEqual(workflow["extra"], document["extra_data"]["extra_pnginfo"]["workflow"]["extra"])

    def test_all_shipped_starters_use_canonical_id(self):
        files = list((ROOT / "workflows").glob("*.json"))
        self.assertEqual(len(files), 8)
        for path in files:
            with self.subTest(path=path.name):
                document = json.loads(path.read_text(encoding="utf-8"))
                self.assertNotIn('"DMAIPrompter"', path.read_text(encoding="utf-8"))
                if path.name.endswith(".api.json"):
                    self.assertEqual(document["1"]["class_type"], "DMAINodesPrompter")
                    self.assertEqual(document["3"]["inputs"]["request"], ["1", 0])
                else:
                    self.assertEqual(document["nodes"][0]["type"], "DMAINodesPrompter")

    def test_cli_creates_copy_and_refuses_same_or_existing_path(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.json"
            output = Path(directory) / "migrated.json"
            source.write_text(json.dumps(api_graph()), encoding="utf-8")
            original_bytes = source.read_bytes()
            with redirect_stdout(io.StringIO()):
                migration.main([str(source), "--output", str(output)])
            self.assertEqual(source.read_bytes(), original_bytes)
            self.assertEqual(json.loads(output.read_text())["1"]["class_type"], "DMAINodesPrompter")
            output_bytes = output.read_bytes()
            for target in (source, output):
                with self.subTest(target=target), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
                    migration.main([str(source), "--output", str(target)])
                self.assertEqual(raised.exception.code, 2)
            self.assertEqual(source.read_bytes(), original_bytes)
            self.assertEqual(output.read_bytes(), output_bytes)

    def test_runner_migrates_in_memory_without_rewriting_input(self):
        graph = json.loads((ROOT / "workflows" / "DMAI-NODES-SDXL.api.json").read_text())
        graph["1"]["class_type"] = "DMAIPrompter"
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "old.api.json"
            source.write_text(json.dumps(graph), encoding="utf-8")
            before = source.read_bytes()
            argv = ["run_workflow.py", "--workflow", str(source), "--prompt", "Updated prompt", "--count", "2"]
            with patch("sys.argv", argv), patch.object(run_workflow, "call", return_value={"prompt_id": "qa-job"}) as queued, redirect_stdout(io.StringIO()):
                run_workflow.main()
            submitted = queued.call_args.args[2]["prompt"]
            self.assertEqual(submitted["1"]["class_type"], "DMAINodesPrompter")
            request = json.loads(submitted["1"]["inputs"]["config_json"])
            self.assertEqual((request["prompt"], request["count"]), ("Updated prompt", 2))
            self.assertEqual(source.read_bytes(), before)

    def test_runner_refuses_legacy_node_before_network_call(self):
        graph = api_graph()
        graph["1"]["inputs"] = {"clip": ["2", 0], "prompt": "Legacy"}
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "legacy.api.json"
            source.write_text(json.dumps(graph), encoding="utf-8")
            argv = ["run_workflow.py", "--workflow", str(source), "--prompt", "New"]
            with patch("sys.argv", argv), patch.object(run_workflow, "call") as queued, redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                run_workflow.main()
            queued.assert_not_called()


if __name__ == "__main__":
    unittest.main()
