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
test("manual settings survive enhancedroundtrips and model changes", () => {
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
