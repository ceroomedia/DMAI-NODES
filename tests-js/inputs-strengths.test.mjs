import test from "node:test";
import assert from "node:assert/strict";
import { LoRAStack } from "../web/inputs.mjs";

function stack() {
  const instance = Object.create(LoRAStack.prototype);
  instance.value = {
    schema_version: 1,
    entries: [
      { id: "a", name: "first.safetensors", enabled: true, strength_model: 1, strength_clip: 0.4 },
      { id: "b", name: "folder/second.safetensors", enabled: true, strength_model: 0.8, strength_clip: 0.2 },
    ],
  };
  instance.saved = [];
  instance.persist = () => instance.saved.push(structuredClone(instance.value));
  instance.note = () => {};
  instance.error = (error) => { instance.lastError = error.message; };
  instance.summary = { textContent: "" };
  instance.body = { querySelectorAll: () => [], querySelector: () => null };
  instance.build = () => {};
  return instance;
}

function draft(entryId, channel, value) {
  return {
    value,
    dataset: { entryId, strength: channel },
    attributes: {},
    setAttribute(name, text) { this.attributes[name] = text; },
    removeAttribute(name) { delete this.attributes[name]; },
    focus() { this.focused = true; },
  };
}

test("inline model and CLIP controls persist independently by ID after state replacement", () => {
  const instance = stack();
  instance.value = structuredClone(instance.value);
  assert.equal(instance.updateStrength("b", "0.55", "clip"), true);
  assert.equal(instance.updateStrength("b", "-0.25", "model"), true);
  assert.equal(instance.value.entries[1].strength_clip, 0.55);
  assert.equal(instance.value.entries[1].strength_model, -0.25);
  assert.equal(instance.value.entries[0].strength_clip, 0.4);
  assert.equal(instance.saved.at(-1).entries[1].strength_clip, 0.55);
});

test("reordering synchronizes both inline strength drafts with the same entry", () => {
  const instance = stack();
  const controls = [draft("b", "model", "0.65"), draft("b", "clip", "0.35")];
  instance.body.querySelectorAll = () => controls;
  globalThis.CSS ??= { escape: (value) => value };
  instance.move("b", 0);
  assert.deepEqual(instance.value.entries.map((entry) => entry.id), ["b", "a"]);
  assert.equal(instance.value.entries[0].strength_model, 0.65);
  assert.equal(instance.value.entries[0].strength_clip, 0.35);
});

test("invalid inline CLIP drafts block reorder and keep the last valid CLIP strength", () => {
  for (const value of ["", "-", "21", "NaN", "Infinity"]) {
    const instance = stack();
    const control = draft("b", "clip", value);
    instance.body.querySelectorAll = () => [control];
    instance.move("b", 0);
    assert.deepEqual(instance.value.entries.map((entry) => entry.id), ["a", "b"]);
    assert.equal(instance.value.entries[1].strength_clip, 0.2);
    assert.equal(instance.saved.length, 0);
    assert.equal(control.attributes["aria-invalid"], "true");
    assert.equal(control.focused, true);
    assert.match(instance.lastError, /^CLIP strength/);
  }
});

test("active count updates when both strengths reach zero without rebuilding controls", () => {
  const instance = stack();
  instance.updateStrength("a", "0", "model");
  assert.match(instance.summary.textContent, /^2 active/);
  instance.updateStrength("a", "0", "clip");
  assert.match(instance.summary.textContent, /^1 active/);
  instance.updateStrength("a", "0.1", "clip");
  assert.match(instance.summary.textContent, /^2 active/);
});
