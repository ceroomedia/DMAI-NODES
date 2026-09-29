import test from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../web/engine.mjs";
import { Gallery } from "../web/gallery.mjs";
const original = {
  steps: 8,
  cfg: 1.1,
  sampler: "euler",
  scheduler: "beta",
  denoise: 1,
  enhancer: "krea2t",
};
function engine() {
  const instance = Object.create(Engine.prototype);
  instance.node = { properties: {}, inputs: [] };
  instance.value = {
    schema_version: 1,
    profile_id: "krea2-turbo",
    mode: "enhanced",
    preset_id: "original",
    settings: structuredClone(original),
    seed: 123,
    models: {
      diffusion_model: "krea",
      text_encoder: "qwen",
      vae: "wan",
      checkpoint: "",
    },
    presets: [],
  };
  instance.data = {
    profiles: [
      {
        id: "krea2-turbo",
        family: "krea2",
        model_fields: [],
        default_settings: original,
      },
      {
        id: "sdxl-checkpoint",
        family: "sdxl",
        model_fields: [
          { key: "checkpoint", inventory: "checkpoints", default: "" },
        ],
        default_settings: { ...original, steps: 20, cfg: 7, enhancer: "none" },
      },
    ],
    models: { checkpoints: ["sdxl"] },
    presets: [
      { id: "original", model: { id: "krea2-turbo" }, settings: original },
    ],
  };
  instance.persist = () => {};
  instance.build = () => {};
  instance.error = (error) => {
    throw error;
  };
  return instance;
}
test("manual settings survive Enhanced roundtrips and model changes", () => {
  const e = engine();
  e.applyMode("manual");
  e.value.settings.steps = 23;
  e.value.settings.sampler = "heun";
  e.applyMode("enhanced");
  assert.equal(e.value.settings.steps, 8);
  e.applyMode("manual");
  assert.equal(e.value.settings.steps, 23);
  assert.equal(e.value.settings.sampler, "heun");
  e.changeProfile("sdxl-checkpoint");
  e.value.models.checkpoint = "sdxl";
  e.value.settings.steps = 31;
  e.changeProfile("krea2-turbo");
  assert.equal(e.value.settings.steps, 23);
  assert.equal(e.value.models.diffusion_model, "krea");
  e.changeProfile("sdxl-checkpoint");
  assert.equal(e.value.settings.steps, 31);
  assert.equal(e.value.models.checkpoint, "sdxl");
});
test("new architecture selections use Manual even when built-in presets exist", () => {
  const e = engine();
  e.data.presets.push({
    id: "sdxl-builtin", model: { id: "sdxl-checkpoint" },
    settings: { ...original, steps: 99, enhancer: "none" },
  });
  e.changeProfile("sdxl-checkpoint");
  assert.equal(e.value.mode, "manual");
  assert.equal(e.value.preset_id, "");
  assert.equal(e.value.settings.steps, 20);
  assert.equal(e.value.settings.enhancer, "none");
});
test("Enhanced opens before upload without choosing a built-in preset or losing a manual draft", () => {
  const e = engine();
  e.value.mode = "manual";
  e.value.preset_id = "";
  e.value.settings = { ...original, steps: 33, sampler: "heun", enhancer: "none" };
  const manual = structuredClone(e.value.settings);
  e.applyMode("enhanced");
  assert.equal(e.value.mode, "enhanced");
  assert.equal(e.value.preset_id, "");
  assert.equal(e.chosen(), undefined);
  assert.deepEqual(e.availablePresets(), []);
  e.applyMode("manual");
  assert.deepEqual(e.value.settings, manual);
});
test("Enhanced choices expose imports and only the selected legacy preset", () => {
  const e = engine();
  e.data.presets.push({ id: "hidden-builtin", model: { id: "krea2-turbo" }, settings: original });
  e.value.presets.push(
    { id: "my-krea", model: { id: "krea2-turbo" }, settings: { ...original, steps: 10 } },
    { id: "my-sdxl", model: { id: "sdxl-checkpoint" }, settings: { ...original, enhancer: "none" } },
  );
  assert.deepEqual(e.availablePresets().map((preset) => preset.id), ["original", "my-krea"]);
  assert.equal(e.selectPreset("hidden-builtin"), false);
  assert.equal(e.selectPreset("my-sdxl"), false);
  assert.equal(e.selectPreset("my-krea"), true);
  assert.equal(e.value.settings.steps, 10);
  assert.deepEqual(e.availablePresets().map((preset) => preset.id), ["my-krea"]);
});
test("JSON upload is exclusive to Enhanced and retains the manual draft", async () => {
  const e = engine();
  const imported = { id: "uploaded", model: { id: "krea2-turbo" }, settings: { ...original, steps: 16 } };
  let calls = 0;
  e.context = { api: { async fetchApi() {
    calls += 1;
    return { ok: true, async json() { return { ok: true, data: { presets: [imported] } }; } };
  } } };
  e.note = () => {};
  const file = { size: 123, async text() { return JSON.stringify(imported); } };
  e.applyMode("manual");
  e.value.settings.steps = 29;
  await assert.rejects(e.importFile(file), /Switch to DMAI Enhanced/);
  assert.equal(calls, 0);
  e.applyMode("enhanced");
  await e.importFile(file);
  assert.equal(calls, 1);
  assert.equal(e.value.mode, "enhanced");
  assert.equal(e.value.preset_id, "uploaded");
  assert.equal(e.value.settings.steps, 16);
  e.applyMode("manual");
  assert.equal(e.value.settings.steps, 29);
});
test("an upload cannot override a mode change while validation is pending", async () => {
  const e = engine();
  const before = structuredClone(e.value);
  e.context = { api: { async fetchApi() {
    e.applyMode("manual");
    return { ok: true, async json() { return { ok: true, data: { presets: [] } }; } };
  } } };
  await assert.rejects(e.importFile({ size: 2, async text() { return "{}"; } }), /changed during upload/);
  assert.equal(e.value.mode, "manual");
  assert.deepEqual(e.value.presets, before.presets);
  assert.deepEqual(e.value.settings, before.settings);
});
function sizedEngine(height = 748) {
  const e = engine();
  e.value.mode = "manual";
  e.minWidth = 440;
  e.minHeight = 700;
  e.node.size = [484, height];
  e.node.setSize = (size) => { e.node.size = size; };
  return e;
}
test("Engine height follows minimum-size mode changes and the Krea-only row", () => {
  const e = sizedEngine();
  e.fitHeight({ family: "qwen_image" });
  assert.deepEqual(e.node.size, [484, 748]);
  e.fitHeight({ family: "krea2" });
  assert.deepEqual(e.node.size, [484, 818]);
  e.value.mode = "enhanced";
  e.fitHeight({ family: "krea2" });
  assert.deepEqual(e.node.size, [484, 648]);
  e.value.mode = "manual";
  e.fitHeight({ family: "qwen_image" });
  assert.deepEqual(e.node.size, [484, 748]);
});
test("Engine preserves a saved larger height through automatic Krea growth and Enhanced", () => {
  const e = sizedEngine(800);
  e.fitHeight({ family: "qwen_image" });
  assert.equal(e.node.size[1], 800);
  e.fitHeight({ family: "krea2" });
  assert.equal(e.node.size[1], 818);
  e.value.mode = "enhanced";
  e.fitHeight({ family: "krea2" });
  assert.equal(e.node.size[1], 800);
  e.node.size = [620, 940];
  e.fitHeight({ family: "krea2" });
  assert.deepEqual(e.node.size, [620, 940]);
  // Returning the node to its minimum explicitly opts back into fitting.
  e.node.size = [620, 648];
  e.fitHeight({ family: "krea2" });
  assert.deepEqual(e.node.size, [620, 648]);
  e.value.mode = "manual";
  e.fitHeight({ family: "qwen_image" });
  assert.deepEqual(e.node.size, [620, 748]);
});
test("Comfy widget padding is part of the minimum rather than a user resize", () => {
  const e = sizedEngine(766);
  e.node.computeSize = () => [484, e.minimumSize()[1] + 18];
  e.fitHeight({ family: "qwen_image" });
  assert.equal(e.node.size[1], 766);
  assert.equal(e.preferredEngineHeight, undefined);
  e.value.mode = "enhanced";
  e.fitHeight({ family: "qwen_image" });
  assert.equal(e.node.size[1], 666);
  e.value.mode = "manual";
  e.fitHeight({ family: "krea2" });
  assert.equal(e.node.size[1], 836);
  assert.equal(e.preferredEngineHeight, undefined);
});
test("a saved Enhanced node starts at its own minimum without Manual expansion", () => {
  const e = sizedEngine(666);
  e.value.mode = "enhanced";
  e.native = { value: JSON.stringify(e.value) };
  e.node.computeSize = () => [484, e.minimumSize()[1] + 18];
  e.initializeSize();
  assert.equal(e.minHeight, 600);
  assert.equal(e.node.size[1], 666);
  e.fitHeight({ family: "krea2" });
  assert.equal(e.node.size[1], 666);
  assert.equal(e.preferredEngineHeight, undefined);
  e.native.value = "{invalid";
  e.initializeSize();
  assert.equal(e.minHeight, 700);
  assert.equal(e.native.value, "{invalid");
});
test("invalid uncommitted controls prevent mode and profile changes", () => {
  const e = engine();
  e.commitManual = () => false;
  e.applyMode("manual");
  assert.equal(e.value.mode, "enhanced");
  e.changeProfile("sdxl-checkpoint");
  assert.equal(e.value.profile_id, "krea2-turbo");
});
test("external sampler and sigmas are independent and linkzero is connected", () => {
  const e = engine();
  e.node.inputs = [
    { name: "sampler", link: 0 },
    { name: "sigmas", link: null },
  ];
  assert.equal(e.linked("sampler"), true);
  assert.equal(e.samplingSummary(original), "Connected sampler / beta");
  e.node.inputs = [
    { name: "sampler", link: null },
    { name: "sigmas", link: 12 },
  ];
  assert.equal(e.samplingSummary(original), "euler / connected sigmas");
});
test("deselect from SelectAll preserves offscreen selections", () => {
  const g = Object.create(Gallery.prototype);
  g.selection = {
    all: true,
    ids: new Set(["loaded", "offscreen"]),
    watermark: 42,
  };
  g.build = () => {};
  g.toggle("loaded");
  assert.equal(g.selection.all, false);
  assert.deepEqual([...g.selection.ids], ["offscreen"]);
  assert.equal(g.selection.watermark, 42);
});
