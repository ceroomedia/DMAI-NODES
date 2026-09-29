"""Copy an old DMAI NODES workflow to the conflict-free Prompter ID.

The old Suite's CLIP Prompter and ambiguous nodes are left untouched. This tool
uses only the Python standard library and never overwrites the input or output.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import json
from pathlib import Path


OLD_PROMPTER_ID = "DMAIPrompter"
PROMPTER_ID = "DMAINodesPrompter"
PROMPT_KEYS = {"schema_version", "prompt", "negative_prompt", "width", "height", "count"}


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def _invalid_constant(value):
    raise ValueError(f"Invalid JSON constant: {value}")


def read_json(raw):
    return json.loads(raw, object_pairs_hook=_unique_object, parse_constant=_invalid_constant)


def _prompt_config(raw):
    """Require the complete v1 request contract, not a coincidental JSON field."""
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > 128 * 1024:
        return None
    try:
        value = read_json(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(value, dict) or set(value) != PROMPT_KEYS:
        return None
    if type(value["schema_version"]) is not int or value["schema_version"] != 1:
        return None
    for key in ("prompt", "negative_prompt"):
        if not isinstance(value[key], str) or len(value[key]) > 65536 or "\x00" in value[key]:
            return None
    for key in ("width", "height"):
        if type(value[key]) is not int or not 64 <= value[key] <= 8192 or value[key] % 64:
            return None
    if value["width"] * value["height"] > 16777216:
        return None
    if type(value["count"]) is not int or not 1 <= value["count"] <= 8:
        return None
    return value


def _is_ui_prompter(node):
    outputs = node.get("outputs")
    if not isinstance(outputs, list) or len(outputs) != 1:
        return False
    output = outputs[0]
    if (not isinstance(output, dict) or output.get("name") != "request"
            or output.get("type") != "DMAI_PROMPT"
            or ("slot_index" in output and (type(output["slot_index"]) is not int or output["slot_index"] != 0))):
        return False
    inputs = node.get("inputs", [])
    if not isinstance(inputs, list) or any(
        not isinstance(item, dict) or item.get("name") not in {"config_json", "text"}
        or item.get("type") != "STRING" for item in inputs
    ):
        return False
    if len({item["name"] for item in inputs}) != len(inputs):
        return False
    candidates = []
    if "widgets_values" in node:
        values = node["widgets_values"]
        if not isinstance(values, list) or len(values) != 1:
            return False
        candidates.append(_prompt_config(values[0]))
    if "widgets_values_named" in node:
        values = node["widgets_values_named"]
        if not isinstance(values, dict) or set(values) != {"config_json"}:
            return False
        candidates.append(_prompt_config(values["config_json"]))
    return bool(candidates) and all(value is not None and value == candidates[0] for value in candidates)


def _link_from(value, node_id):
    return (isinstance(value, list) and len(value) == 2
            and type(value[0]) in (str, int) and str(value[0]) == str(node_id))


def _is_api_prompter(node_id, node, graph):
    inputs = node.get("inputs")
    if (not isinstance(inputs, dict) or set(inputs) - {"config_json", "text"}
            or _prompt_config(inputs.get("config_json")) is None):
        return False
    # API JSON has no typed outputs. A slot-zero request link to our Engine is
    # the extra evidence that distinguishes this from a legacy Suite node.
    linked_engine = False
    for target in graph.values():
        if not isinstance(target, dict) or not isinstance(target.get("inputs"), dict):
            continue
        for name, value in target["inputs"].items():
            if not _link_from(value, node_id):
                continue
            if type(value[1]) is not int or value[1] != 0:
                return False
            if target.get("class_type") == "DMAIGenerationEngine" and name == "request":
                linked_engine = True
    return linked_engine


def migrate_workflow(document):
    """Return a migrated deep copy plus node paths; never change the caller's data."""
    if not isinstance(document, dict):
        raise ValueError("Expected a ComfyUI workflow or API prompt JSON object.")
    result = deepcopy(document)
    report = {"migrated": [], "preserved": []}

    def visit_graph(graph, path):
        if not isinstance(graph, dict):
            return
        nodes = graph.get("nodes")
        if isinstance(nodes, list):
            for index, node in enumerate(nodes):
                if not isinstance(node, dict) or node.get("type") != OLD_PROMPTER_ID:
                    continue
                location = f"{path}.nodes[{index}]"
                if _is_ui_prompter(node):
                    node["type"] = PROMPTER_ID
                    properties = node.get("properties")
                    if isinstance(properties, dict) and properties.get("Node name for S&R") == OLD_PROMPTER_ID:
                        properties["Node name for S&R"] = PROMPTER_ID
                    report["migrated"].append(location)
                else:
                    report["preserved"].append(location)
        else:
            for node_id, node in graph.items():
                if not isinstance(node, dict) or node.get("class_type") != OLD_PROMPTER_ID:
                    continue
                location = f"{path}[{node_id!r}]"
                if _is_api_prompter(node_id, node, graph):
                    node["class_type"] = PROMPTER_ID
                    report["migrated"].append(location)
                else:
                    report["preserved"].append(location)
        # Serialized LiteGraph subgraphs live in definitions.subgraphs. Do not
        # recursively scan arbitrary metadata, prompt text, or node properties.
        definitions = graph.get("definitions")
        if isinstance(definitions, dict) and isinstance(definitions.get("subgraphs"), list):
            for index, subgraph in enumerate(definitions["subgraphs"]):
                visit_graph(subgraph, f"{path}.definitions.subgraphs[{index}]")
        for key in ("workflow", "prompt"):
            if isinstance(graph.get(key), dict) and "class_type" not in graph[key]:
                visit_graph(graph[key], f"{path}.{key}")
        extra_data = graph.get("extra_data")
        if isinstance(extra_data, dict):
            extra_pnginfo = extra_data.get("extra_pnginfo")
            if isinstance(extra_pnginfo, dict):
                visit_graph(extra_pnginfo.get("workflow"), f"{path}.extra_data.extra_pnginfo.workflow")

    visit_graph(result, "$")
    return result, report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Existing UI workflow or API prompt JSON")
    parser.add_argument("--output", required=True, type=Path, help="New JSON filename; must not already exist")
    args = parser.parse_args(argv)
    if args.input.resolve() == args.output.resolve():
        parser.error("Input and output must be different files. The original is always preserved.")
    if args.output.exists():
        parser.error("Output already exists. Choose a new filename; existing files are never overwritten.")
    try:
        document = read_json(args.input.read_text(encoding="utf-8-sig"))
        result, report = migrate_workflow(document)
        data = (json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")
        with args.output.open("xb") as output:
            output.write(data)
    except (OSError, ValueError, TypeError) as error:
        parser.error(str(error))
    print(f"Saved: {args.output}")
    print(f"Migrated {len(report['migrated'])} DMAI NODES Prompter node(s).")
    print(f"Preserved {len(report['preserved'])} legacy or ambiguous DMAIPrompter node(s).")
    for path in report["preserved"]:
        print(f"  Unchanged: {path}")


if __name__ == "__main__":
    main()
