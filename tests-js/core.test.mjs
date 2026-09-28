import test from "node:test";
import assert from "node:assert/strict";
import {
  readPrompt,
  dimensions,
  customDimensions,
  readManifest,
  moveEntry,
  readEngine,
  mergePresets,
  selectionBody,
  envelope,
} from "../web/core.mjs";
const prompt = {
  schema_version: 1,
  prompt: "A quiet studio",
  negative_prompt: "",
  width: 832,
  height: 1024,
  count: 4,
};
const settings = {
  steps: 8,
  cfg: 1.1,
  sampler: "euler",
  scheduler: "beta",
  denoise: 1,
  enhancer: "krea2t",
};
const engine = {
  schema_version: 1,
  profile_id: "krea2-turbo",
  mode: "enhanced",
  preset_id: "dmai-krea2-original-v1",
  settings,
  seed: 481516,
  models: {
    diffusion_model: "krea.safetensors",
    text_encoder: "qwen.safetensors",
    vae: "wan.safetensors",
    checkpoint: "",
  },
  presets: [],
};
test("custom sizes explicitly normalize a64px grid, reject empty and out-of-range input", () => {
  assert.deepEqual(customDimensions(1080, 1920), [1088, 1920]);
  assert.throws(() => customDimensions(NaN, 1024));
  assert.throws(() => customDimensions(8193, 1024));
  assert.deepEqual(dimensions("4:5", "1K"), [832, 1024]);
  assert.deepEqual(dimensions("9:19.5", "2K"), [960, 2048]);
});
test("headless prompt values remain authoritative regardless of UI intent", () => {
  assert.deepEqual(readPrompt(JSON.stringify(prompt)), prompt);
  for (const patch of [
    { count: "4" },
    { width: 1080 },
    { count: 9 },
    { negative_prompt: null },
  ])
    assert.throws(() => readPrompt(JSON.stringify({ ...prompt, ...patch })));
  assert.throws(() => readPrompt("broken"), /preserved/);
});
test("LoRA reorder moves the whole entry with independent strengths and switches", () => {
  const entries = [
    {
      id: "a",
      name: "Upper/File.safetensors",
      enabled: false,
      strength_model: 2,
      strength_clip: -0.3,
    },
    {
      id: "b",
      name: "lower\\file.safetensors",
      enabled: true,
      strength_model: 12,
      strength_clip: 1,
    },
  ];
  const result = moveEntry(entries, "a", 1);
  assert.equal(result[1], entries[0]);
  assert.equal(result[1].enabled, false);
  assert.equal(result[1].strength_clip, -0.3);
  assert.equal(entries[0].id, "a");
  assert.deepEqual(moveEntry(entries, "bad", 1), entries);
  assert.deepEqual(
    readManifest(JSON.stringify({ schema_version: 1, entries })).entries,
    entries,
  );
});
test("invalid LoRA booleans and duplicate IDs never silently reset", () => {
  for (const entries of [
    [
      {
        id: "a",
        name: "x",
        enabled: "false",
        strength_model: 1,
        strength_clip: 1,
      },
    ],
    [
      {
        id: "a",
        name: "x",
        enabled: true,
        strength_model: 1,
        strength_clip: 1,
      },
      {
        id: "a",
        name: "y",
        enabled: true,
        strength_model: 1,
        strength_clip: 1,
      },
    ],
  ])
    assert.throws(() =>
      readManifest(JSON.stringify({ schema_version: 1, entries })),
    );
});
test("external64-bit seeds preserve exactdecimal strings", () => {
  const value = { ...engine, seed: "18446744073709551615" };
  assert.deepEqual(readEngine(JSON.stringify(value)), value);
  assert.throws(() =>
    readEngine(JSON.stringify({ ...engine, seed: "18446744073709551616" })),
  );
  assert.throws(() =>
    readEngine(
      JSON.stringify({ ...engine, seed: Number.MAX_SAFE_INTEGER + 1 }),
    ),
  );
});
test("import IDs cannot replace builtins or overwrite earlier imports", () => {
  const builtins = [{ id: "official" }],
    existing = [{ id: "mine" }];
  assert.throws(() => mergePresets(existing, [{ id: "official" }], builtins));
  assert.throws(() => mergePresets(existing, [{ id: "mine" }], builtins));
  assert.throws(() =>
    mergePresets(existing, [{ id: "new" }, { id: "new" }], builtins),
  );
  assert.deepEqual(mergePresets(existing, [{ id: "new" }], builtins), [
    { id: "mine" },
    { id: "new" },
  ]);
  assert.equal(existing.length, 1);
});
test("ZIP takes an immutable selection snapshot and alluses watermarked history", () => {
  const ids = new Set(["one", "two"]);
  const body = selectionBody({ all: false, ids }, 42);
  ids.add("three");
  assert.deepEqual(body, { ids: ["one", "two"] });
  assert.deepEqual(selectionBody({ all: true, ids }, 42), {
    all: true,
    before: 42,
  });
  assert.throws(() => selectionBody({ all: true, ids }, undefined));
  assert.throws(() => selectionBody({ all: false, ids: new Set() }, 42));
});
test("HTTP errors are visible even when HTTP200 has a failure envelope", async () => {
  const api = {
    fetchApi: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: false,
        error: { message: "Missing model file" },
      }),
    }),
  };
  await assert.rejects(() => envelope(api, "/bootstrap"), /Missing model file/);
});
