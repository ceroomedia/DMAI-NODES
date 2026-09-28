import test from "node:test";
import assert from "node:assert/strict";
import { Controller } from "../web/dom.mjs";
import { LoRAStack } from "../web/inputs.mjs";

function loras() {
  const instance = Object.create(LoRAStack.prototype);
  instance.value = {
    schema_version: 1,
    entries: [
      {
        id: "a",
        name: "A",
        enabled: true,
        strength_model: 1,
        strength_clip: 1,
      },
      {
        id: "b",
        name: "B",
        enabled: true,
        strength_model: 1,
        strength_clip: 0.4,
      },
    ],
  };
  instance.saved = [];
  instance.persist = () => instance.saved.push(structuredClone(instance.value));
  instance.note = () => {};
  instance.error = (error) => {
    instance.lastError = error.message;
  };
  instance.body = { querySelectorAll: () => [], querySelector: () => null };
  instance.build = () => {};
  return instance;
}

test("LoRA strength input persists by stable ID through reorder and keeps CLIP independent", () => {
  const instance = loras();
  assert.equal(instance.updateStrength("b", "0.65"), true);
  // Model an external state replacement: input events must resolve the new row.
  instance.value = structuredClone(instance.value);
  assert.equal(instance.updateStrength("b", "0.65"), true);
  globalThis.CSS ??= { escape: (value) => value };
  instance.move("b", 0);
  assert.deepEqual(
    instance.value.entries.map((entry) => entry.id),
    ["b", "a"],
  );
  assert.equal(instance.value.entries[0].strength_model, 0.65);
  assert.equal(instance.value.entries[0].strength_clip, 0.4);
  assert.equal(instance.saved.at(-1).entries[0].strength_model, 0.65);
});

test("LoRA actions sync a valid DOM draft even before change or blur fires", () => {
  const instance = loras();
  const control = {
    value: "0.65",
    dataset: { entryId: "b" },
    removeAttribute() {},
  };
  instance.body.querySelectorAll = () => [control];
  instance.move("b", 0);
  assert.equal(instance.value.entries[0].id, "b");
  assert.equal(instance.value.entries[0].strength_model, 0.65);
});

test("invalid LoRA drafts block synchronization and reorder without silently resetting", () => {
  for (const value of ["", "-", "21", "NaN"]) {
    const instance = loras();
    const control = {
      value,
      dataset: { entryId: "b" },
      setAttribute(name, text) {
        this[name] = text;
      },
      focus() {
        this.focused = true;
      },
    };
    instance.body.querySelectorAll = () => [control];
    assert.equal(instance.syncStrengths(), false);
    instance.move("b", 0);
    assert.deepEqual(
      instance.value.entries.map((entry) => entry.id),
      ["a", "b"],
    );
    assert.equal(instance.value.entries[1].strength_model, 1);
    assert.equal(instance.saved.length, 0);
    assert.equal(control["aria-invalid"], "true");
    assert.equal(control.focused, true);
    assert.match(instance.lastError, /Correct it before queueing/);
  }
});

function controller(configuring = false) {
  const instance = Object.create(Controller.prototype);
  instance.native = { value: "old" };
  instance.context = { isConfiguring: () => configuring };
  instance.events = [];
  const record = (name) => () =>
    instance.events.push([name, instance.native.value]);
  instance.context.beforeChange = record("canvas-before");
  instance.context.afterChange = record("canvas-after");
  instance.native.callback = record("callback");
  instance.node = {
    graph: {
      beforeChange: record("before"),
      afterChange: record("after"),
      change: record("change"),
      setDirtyCanvas: record("draw"),
    },
  };
  return instance;
}

test("widget edits notify Comfy history before mutation and workflow dirty state afterward", () => {
  const instance = controller();
  instance.set("new");
  assert.deepEqual(instance.events, [
    ["before", "old"],
    ["canvas-before", "old"],
    ["callback", "new"],
    ["after", "new"],
    ["canvas-after", "new"],
    ["change", "new"],
    ["draw", "new"],
  ]);
  assert.equal(instance.writing, false);
  instance.events = [];
  instance.set("new");
  assert.deepEqual(instance.events, []);
});

test("graph restoration does not create undo or dirty notifications", () => {
  const instance = controller(true);
  instance.set({ restored: true });
  assert.deepEqual(instance.events, [
    ["callback", '{"restored":true}'],
    ["draw", '{"restored":true}'],
  ]);
});
