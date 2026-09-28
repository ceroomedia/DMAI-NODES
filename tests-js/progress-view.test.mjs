import test from "node:test";
import assert from "node:assert/strict";
import { progressPresentation, perimeterPath } from "../web/progress-view.mjs";
import { Prompter } from "../web/inputs.mjs";

test("the outline uses measured progress and only completes after the workflow succeeds", () => {
  const sampling = progressPresentation({ phase: "sampling", percent: 37.25 });
  assert.equal(sampling.percent, 37.25);
  assert.equal(sampling.value, 37);
  assert.equal(sampling.busy, true);
  assert.equal(progressPresentation({ phase: "saving", percent: 100 }).value, 99);
  const complete = progressPresentation({ phase: "complete", percent: 100 });
  assert.equal(complete.percent, 100);
  assert.equal(complete.busy, false);
  assert.equal(progressPresentation({ phase: "error", percent: 48 }).percent, 48);
  assert.equal(progressPresentation({ phase: "interrupted", percent: 48 }).busy, false);
});

test("invalid progress cannot create a full, negative or indeterminate border", () => {
  for (const percent of [NaN, Infinity, -7, "42", undefined])
    assert.equal(progressPresentation({ phase: "loading", percent }).percent, 0);
  assert.equal(progressPresentation({ phase: "unknown", percent: 82 }).visible, false);
  assert.equal(progressPresentation().visible, false);
});

test("the resized perimeter starts and closes at the top centre with an inset for sockets", () => {
  assert.equal(
    perimeterPath(400, 500),
    "M 200 2 H 388 Q 398 2 398 12 V 488 Q 398 498 388 498 H 12 Q 2 498 2 488 V 12 Q 2 2 12 2 H 200",
  );
  assert.doesNotMatch(perimeterPath(0, Infinity), /NaN|Infinity|-/);
});

function prompter(generate) {
  const instance = Object.create(Prompter.prototype);
  instance.node = {};
  instance.progress = { phase: "idle", percent: 0 };
  instance.context = { generate };
  instance.runButton = {};
  instance.progressView = { update: progressPresentation, dispose() {} };
  instance.note = () => {};
  instance.error = (error) => { instance.errorMessage = error.message; };
  return instance;
}

test("Generate queues once while awaiting acknowledgement and stays locked while sampling", async () => {
  let calls = 0, acknowledge;
  const waiting = new Promise((resolve) => { acknowledge = resolve; });
  const instance = prompter(async () => { calls++; await waiting; });
  const first = instance.generate();
  assert.equal(instance.runButton.disabled, true);
  await instance.generate();
  assert.equal(calls, 1);
  instance.updateProgress({ phase: "sampling", percent: 38 });
  acknowledge();
  await first;
  assert.equal(instance.runButton.disabled, true);
  await instance.generate();
  assert.equal(calls, 1);
  instance.updateProgress({ phase: "complete", percent: 100 });
  assert.equal(instance.runButton.disabled, false);
  await instance.generate();
  assert.equal(calls, 2);
});

test("queue failure is visible and unlocks Generate for a corrected retry", async () => {
  const instance = prompter(async () => { throw new Error("Choose a model first."); });
  await instance.generate();
  assert.equal(instance.progress.phase, "error");
  assert.equal(instance.errorMessage, "Choose a model first.");
  assert.equal(instance.runButton.disabled, false);
  assert.equal(instance.queuePending, false);
});

test("removing a Prompter releases its observer and progress subscription once", () => {
  const instance = prompter(async () => {});
  let unsubscriptions = 0, disposals = 0;
  instance.dialogs = new Set();
  instance.stopProgress = () => { unsubscriptions++; };
  instance.progressView.dispose = () => { disposals++; };
  instance.dispose();
  instance.dispose();
  assert.equal(unsubscriptions, 1);
  assert.equal(disposals, 1);
  assert.equal(instance.disposed, true);
});
