import test from "node:test";
import assert from "node:assert/strict";
import {
  modelGroups, modelSource, modelToken, parseModelToken, selectedModel, profileForSource,
} from "../web/model-picker.mjs";
import { Engine } from "../web/engine.mjs";

const settings = { steps: 20, cfg: 1, sampler: "euler", scheduler: "simple", denoise: 1, enhancer: "none" };
const profiles = [
  { id: "krea", model_fields: [{ key: "diffusion_model", inventory: "diffusion_models", default: "Krea.safetensors" }, { key: "text_encoder", inventory: "text_encoders", default: "KreaCLIP.safetensors" }], default_settings: settings },
  { id: "sdxl", model_fields: [{ key: "checkpoint", inventory: "checkpoints", default: "" }], default_settings: { ...settings, cfg: 7 } },
  { id: "flux", model_fields: [{ key: "diffusion_model", inventory: "diffusion_models", default: "Flux.safetensors" }, { key: "text_encoder", inventory: "text_encoders", default: "CLIP-L.safetensors" }], default_settings: settings },
];
const inventory = {
  checkpoints: ["Studio\\Model.safetensors", "Same.safetensors"],
  diffusion_models: ["Models/Unknown Future Model.safetensors", "Same.safetensors", "Krea.safetensors", "Flux.safetensors"],
  text_encoders: ["KreaCLIP.safetensors", "CLIP-L.safetensors"],
};

function controller() {
  return Object.assign(Object.create(Engine.prototype), {
    node: { properties: {} },
    data: { profiles, models: inventory, presets: [] },
    value: { profile_id: "flux", mode: "manual", preset_id: "", settings: { ...settings, steps: 31 }, models: { diffusion_model: "Flux.safetensors", text_encoder: "MyEncoder.safetensors", vae: "MyVAE.safetensors", checkpoint: "" }, presets: [] },
    commitControls: () => true,
    persist() { this.saved = structuredClone(this.value); },
    build() {},
    error(error) { throw error; },
  });
}

test("model groups list every native file without guessing its architecture", () => {
  const groups = modelGroups(inventory);
  assert.deepEqual(groups.map((group) => group.label), ["Checkpoints", "Diffusion models"]);
  assert.deepEqual(groups[0].items.map((item) => item.label), inventory.checkpoints);
  assert.deepEqual(groups[1].items.map((item) => item.label), inventory.diffusion_models);
  assert.deepEqual(modelGroups().map((group) => group.items), [[], []]);
});

test("category and exact filename round-trip without collisions or delimiter assumptions", () => {
  const name = 'Folder\\same:model["v2"].safetensors';
  assert.notEqual(modelToken("checkpoint", name), modelToken("diffusion_model", name));
  assert.deepEqual(parseModelToken(modelToken("checkpoint", name)), { key: "checkpoint", name });
  assert.throws(() => parseModelToken('["vae","file"]'));
  assert.throws(() => parseModelToken('["checkpoint",""]'));
  assert.throws(() => parseModelToken('["checkpoint","file","extra"]'));
});

test("saved Windows paths match native separators but never different case or basename", () => {
  const checkpoint = profiles[1];
  const found = selectedModel(checkpoint, { checkpoint: "Studio/Model.safetensors" }, inventory);
  assert.equal(found.available, true);
  assert.equal(found.name, "Studio\\Model.safetensors");
  for (const name of ["studio/Model.safetensors", "Model.safetensors", "Removed.safetensors"]) {
    const missing = selectedModel(checkpoint, { checkpoint: name }, inventory);
    assert.equal(missing.available, false);
    assert.equal(missing.name, name);
  }
});

test("empty or ambiguous model selection is preserved without automatic replacement", () => {
  assert.equal(selectedModel(profiles[0], { diffusion_model: "" }, inventory), null);
  assert.equal(modelSource({ model_fields: [] }), undefined);
  const ambiguous = selectedModel(profiles[1], { checkpoint: "A/B" }, { checkpoints: ["A/B", "A\\B"] });
  assert.equal(ambiguous.available, false);
});

test("category changes prefer current architecture, then the remembered architecture", () => {
  assert.equal(profileForSource(profiles, "diffusion_model", "flux", { diffusion_model: "krea" }).id, "flux");
  assert.equal(profileForSource(profiles, "diffusion_model", "sdxl", { diffusion_model: "flux" }).id, "flux");
  assert.equal(profileForSource(profiles, "checkpoint", "flux").id, "sdxl");
  assert.equal(profileForSource([], "checkpoint", "flux"), undefined);
});

test("choosing a checkpoint routes its native name and restores diffusion drafts on return", () => {
  const engine = controller();
  assert.equal(engine.chooseModel({ key: "checkpoint", name: "Studio\\Model.safetensors" }), true);
  assert.equal(engine.value.profile_id, "sdxl");
  assert.equal(engine.value.models.checkpoint, "Studio\\Model.safetensors");
  assert.equal(engine.value.settings.cfg, 7);
  assert.equal(engine.chooseModel({ key: "diffusion_model", name: "Models/Unknown Future Model.safetensors" }), true);
  assert.equal(engine.value.profile_id, "flux");
  assert.equal(engine.value.models.diffusion_model, "Models/Unknown Future Model.safetensors");
  assert.equal(engine.value.models.text_encoder, "MyEncoder.safetensors");
  assert.equal(engine.value.models.vae, "MyVAE.safetensors");
  assert.equal(engine.value.settings.steps, 31);
});

test("changing architecture in the same category keeps the chosen file and updates encoders", () => {
  const engine = controller();
  engine.changeProfile("krea");
  assert.equal(engine.value.models.diffusion_model, "Flux.safetensors");
  assert.equal(engine.value.models.text_encoder, "KreaCLIP.safetensors");
  engine.changeProfile("flux");
  assert.equal(engine.value.models.diffusion_model, "Flux.safetensors");
  assert.equal(engine.value.models.text_encoder, "MyEncoder.safetensors");
});

test("file changes within an architecture preserve Enhanced preset and settings", () => {
  const engine = controller();
  engine.value.mode = "enhanced";
  engine.value.preset_id = "my-preset";
  const before = structuredClone(engine.value.settings);
  engine.chooseModel({ key: "diffusion_model", name: "Same.safetensors" });
  assert.equal(engine.value.mode, "enhanced");
  assert.equal(engine.value.preset_id, "my-preset");
  assert.deepEqual(engine.value.settings, before);
  assert.equal(engine.value.models.diffusion_model, "Same.safetensors");
});

test("invalid settings block file and architecture changes", () => {
  const engine = controller();
  const before = structuredClone(engine.value);
  engine.commitControls = () => false;
  assert.equal(engine.chooseModel({ key: "checkpoint", name: "Same.safetensors" }), false);
  assert.equal(engine.changeProfile("krea"), false);
  assert.deepEqual(engine.value, before);
});

test("supporting file changes validate pending settings before refreshing missing-file warnings", () => {
  const engine = controller();
  const calls = [];
  engine.commitControls = () => {
    calls.push("commit");
    engine.value.settings.steps = 42;
    engine.value.seed = "123";
    return true;
  };
  engine.persist = () => calls.push("persist");
  engine.build = () => {
    calls.push("build");
    assert.equal(engine.value.models.text_encoder, "CLIP-L.safetensors");
    assert.equal(engine.value.settings.steps, 42);
    assert.equal(engine.value.seed, "123");
  };
  assert.equal(engine.changeModelFile("text_encoder", "CLIP-L.safetensors"), true);
  assert.deepEqual(calls, ["commit", "persist", "build"]);
  calls.length = 0;
  engine.commitControls = () => false;
  assert.equal(engine.changeModelFile("text_encoder", "Other.safetensors"), false);
  assert.equal(engine.value.models.text_encoder, "CLIP-L.safetensors");
  assert.deepEqual(calls, []);
});
