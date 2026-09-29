import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PROMPTER_TYPE, isPreviewPrompter, migratePreviewPrompters } from "../web/workflow-migration.mjs";

const config = { schema_version: 1, prompt: "Saved prompt", negative_prompt: "Saved negative", width: 832, height: 1024, count: 2 };
const preview = (id = 1) => ({
  id, type: "DMAIPrompter", pos: [40, 100], size: [410, 475], flags: {}, order: 0, mode: 0,
  inputs: [{ name: "text", type: "STRING", link: null }],
  outputs: [{ name: "request", type: "DMAI_PROMPT", links: [1], slot_index: 0 }],
  properties: { "Node name for S&R": "DMAIPrompter", dmai_format: { ratio: "4:5", resolution: "1K" } },
  widgets_values: [JSON.stringify(config)],
});
const legacy = (id = 2) => ({
  id, type: "DMAIPrompter", inputs: [{ name: "clip", type: "CLIP", link: 7 }],
  outputs: [{ name: "positive", type: "CONDITIONING", links: [8] }, { name: "negative", type: "CONDITIONING", links: [9] }],
  widgets_values: ["My legacy prompt", "", 1024, 1024],
  properties: { "Node name for S&R": "DMAIPrompter" },
});

test("preview migration changes only type and the matching search-name property, preserving settings and connections", () => {
  const workflow = { nodes: [preview()], links: [[1, 1, 0, 3, 0, "DMAI_PROMPT"]] };
  const expected = structuredClone(workflow);
  expected.nodes[0].type = expected.nodes[0].properties["Node name for S&R"] = PROMPTER_TYPE;
  const node = workflow.nodes[0], widgets = node.widgets_values, links = workflow.links;
  assert.equal(migratePreviewPrompters(workflow), 1);
  assert.deepEqual(workflow, expected);
  assert.equal(workflow.nodes[0], node);
  assert.equal(node.widgets_values, widgets);
  assert.equal(workflow.links, links);
  assert.equal(migratePreviewPrompters(workflow), 0, "migration is idempotent");
});

test("current named and positional widget formats are recognized without changing saved JSON", () => {
  for (const format of ["both", "named"]) {
    const node = preview();
    node.widgets_values_named = { config_json: JSON.stringify(Object.fromEntries(Object.entries(config).reverse()), null, 2) };
    if (format === "named") delete node.widgets_values;
    assert.equal(isPreviewPrompter(node), true);
    const raw = node.widgets_values_named.config_json;
    assert.equal(migratePreviewPrompters({ nodes: [node] }), 1);
    assert.equal(node.widgets_values_named.config_json, raw);
  }
});

test("legacy Suite, standalone, and ambiguous Prompters stay unchanged in mixed workflows", () => {
  const ambiguous = [
    legacy(), { id: 8, type: "DMAIPrompter" },
    { ...preview(9), outputs: [{ name: "request", type: "STRING" }] },
    { ...preview(10), widgets_values: ["{}"] },
    { ...preview(11), inputs: [{ name: "clip", type: "CLIP" }] },
    { ...preview(12), widgets_values: [JSON.stringify(config), "extra"] },
    { ...preview(13), outputs: [{ name: "request", type: "DMAI_PROMPT", slot_index: 1 }] },
    { ...preview(14), widgets_values_named: { config_json: JSON.stringify({ ...config, prompt: "Conflicting value" }) } },
    { ...preview(15), widgets_values_named: { unrelated: JSON.stringify(config) } },
    { ...preview(16), widgets_values: ["invalid"], widgets_values_named: { config_json: JSON.stringify(config) } },
    { ...preview(17), widgets_values_named: { config_json: JSON.stringify(config), unrelated: "value" } },
    { ...preview(18), widgets_values: undefined },
  ];
  const before = structuredClone(ambiguous);
  const workflow = { nodes: [preview(), ...ambiguous, { ...preview(20), type: PROMPTER_TYPE }] };
  assert.equal(migratePreviewPrompters(workflow), 1);
  assert.deepEqual(ambiguous, before);
});

test("invalid and extra-key configurations cannot cause a legacy ID rewrite", () => {
  for (const change of [
    { schema_version: true }, { clip: "legacy" }, { prompt: null }, { negative_prompt: 5 },
    { width: 833 }, { height: 0 }, { count: 9 }, { count: true }, { width: 8192, height: 8192 },
    { prompt: "bad\0value" }, { prompt: "x".repeat(65537) },
  ]) {
    const node = preview();
    node.widgets_values = [JSON.stringify({ ...config, ...change })];
    assert.equal(isPreviewPrompter(node), false, JSON.stringify(Object.keys(change)));
    assert.equal(migratePreviewPrompters({ nodes: [node] }), 0);
  }
});

test("prompt length validation counts Unicode characters consistently with the Python backend", () => {
  const node = preview();
  node.widgets_values = [JSON.stringify({ ...config, prompt: "\u{1F30C}".repeat(32000) })];
  assert.equal(isPreviewPrompter(node), true);
  node.widgets_values = [JSON.stringify({ ...config, prompt: "x".repeat(65537) })];
  assert.equal(isPreviewPrompter(node), false);
});

test("migration respects the backend's 128 KiB serialized UTF-8 configuration limit", () => {
  const node = preview();
  const raw = JSON.stringify(config);
  const atLimit = raw + " ".repeat(128 * 1024 - new TextEncoder().encode(raw).byteLength);
  node.widgets_values = [atLimit];
  assert.equal(isPreviewPrompter(node), true);
  node.widgets_values = [atLimit + " "];
  assert.equal(isPreviewPrompter(node), false);
  node.widgets_values = [JSON.stringify({ ...config, prompt: "\u{1F30C}".repeat(32768) })];
  const before = structuredClone(node);
  assert.equal(migratePreviewPrompters({ nodes: [node] }), 0, "Unicode bytes can exceed the serialized cap while the character count is valid");
  assert.deepEqual(node, before);
});

test("all nested Comfy definitions.subgraphs are migrated, while metadata and runtime-style objects stay untouched", () => {
  const nested = { id: "inner-subgraph", nodes: [preview(5), legacy(6)] };
  const outer = {
    id: "outer-subgraph", nodes: [preview(3), { id: 4, type: nested.id }],
    definitions: { subgraphs: [nested] },
    links: [{ id: 1, origin_id: 3, origin_slot: 0, target_id: 4, target_slot: 0, type: "DMAI_PROMPT" }],
  };
  const workflow = {
    nodes: [preview(1), { id: 2, type: outer.id }], definitions: { subgraphs: [outer, nested] },
    extra: { nodeSnapshot: preview(10) }, subgraph: { nodes: [preview(11)] },
  };
  const metadata = structuredClone([workflow.extra, workflow.subgraph]);
  const outerLinks = structuredClone(outer.links), originalLegacy = structuredClone(nested.nodes[1]);
  assert.equal(migratePreviewPrompters(workflow), 3);
  assert.equal(nested.nodes[0].type, PROMPTER_TYPE);
  assert.equal(outer.nodes[0].type, PROMPTER_TYPE);
  assert.deepEqual(outer.links, outerLinks);
  assert.deepEqual(nested.nodes[1], originalLegacy);
  assert.deepEqual([workflow.extra, workflow.subgraph], metadata);
});

test("missing, malformed, or cyclic graph containers are harmless", () => {
  for (const value of [null, undefined, [], 5, "text", {}, { nodes: {} }, { definitions: { subgraphs: {} } }])
    assert.equal(migratePreviewPrompters(value), 0);
  const cycle = { nodes: [preview()], definitions: { subgraphs: [] } };
  cycle.definitions.subgraphs.push(cycle);
  assert.equal(migratePreviewPrompters(cycle), 1);
});

test("custom display titles and search-name metadata are preserved", () => {
  const node = preview();
  node.title = "My saved scene";
  node.properties["Node name for S&R"] = "User custom search name";
  assert.equal(migratePreviewPrompters({ nodes: [node] }), 1);
  assert.equal(node.title, "My saved scene");
  assert.equal(node.properties["Node name for S&R"], "User custom search name");
});

test("extension migrates before configuration and mounts only the package's canonical Prompter", async () => {
  let extension;
  const created = [];
  class FakeController { constructor(node) { created.push(node); } }
  globalThis.__dmaiMigrationTest = {
    app: { registerExtension(value) { extension = value; } }, api: {},
    Prompter: FakeController, LoRAStack: FakeController, Engine: FakeController, Gallery: FakeController,
    GenerationProgress: class {}, envelope() {}, PROMPTER_TYPE, migratePreviewPrompters,
  };
  try {
    let source = await readFile(new URL("../web/dmai-nodes.js", import.meta.url), "utf8");
    source = source.replace(/import\s+(\{[^}]+\})\s+from\s+["'][^"']+["'];/g, "const $1 = globalThis.__dmaiMigrationTest;");
    await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    const workflow = { nodes: [preview(), legacy()] };
    extension.beforeConfigureGraph(workflow);
    assert.equal(workflow.nodes[0].type, PROMPTER_TYPE);
    assert.equal(workflow.nodes[1].type, "DMAIPrompter");
    const newNode = { comfyClass: PROMPTER_TYPE, addDOMWidget() {} };
    extension.nodeCreated(newNode);
    extension.loadedGraphNode(newNode);
    extension.nodeCreated({ comfyClass: "DMAIPrompter", addDOMWidget() {} });
    assert.deepEqual(created, [newNode], "legacy nodes must not receive the new controller");
  } finally { delete globalThis.__dmaiMigrationTest; }
});
