import test from "node:test";
import assert from "node:assert/strict";
import { GenerationProgress } from "../web/progress.mjs";

class Api extends EventTarget {
  clientId = "client-a";
  queue = { queue_running: [], queue_pending: [] };
  history = {};
  calls = [];
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  async fetchApi(path) {
    this.calls.push(path);
    const payload = path === "/queue" ? this.queue : this.history[decodeURIComponent(path.slice("/history/".length))] ?? {};
    return { ok: true, json: async () => payload };
  }
}
function graph(id, nodes) {
  return { id, getNodeById: (value) => nodes.find((node) => String(node.id) === String(value)) };
}
function entry(id, workflowId = "workflow-a", options = {}) {
  const source = options.source ?? "1", engine = options.engine ?? "3";
  const prompt = {
    [source]: { class_type: "DMAINodesPrompter", inputs: { config_json: "{}" } },
    [engine]: { class_type: "DMAIGenerationEngine", inputs: { request: [source, 0] } },
    4: { class_type: "DMAIGallery", inputs: { images: [engine, 0] } },
    ...options.extraNodes,
  };
  return [0, id, prompt, { client_id: options.clientId ?? "client-a", extra_pnginfo: { workflow: { id: workflowId } } }, options.outputs ?? ["4"]];
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
function setup(t) {
  const api = new Api(), node = { id: 1 }, state = { root: graph("workflow-a", [node]) }, seen = [];
  const manager = new GenerationProgress({ api, getRootGraph: () => state.root });
  const stop = manager.watch(node, (value) => seen.push(value));
  manager.start();
  t.after(() => manager.dispose());
  return { api, node, state, seen, manager, stop, last: () => seen.at(-1) };
}
function progress(api, id, fraction, phase = "sampling", nodeId = "3") {
  api.emit("dmai_generation_progress", { prompt_id: id, node_id: nodeId, fraction, phase });
}

test("real batch fractions fill the border and only workflow success reaches 100", async (t) => {
  const { api, manager, node, last } = setup(t);
  let accepted = false;
  const result = manager.generate(node, async () => {
    assert.equal(last().phase, "queued");
    api.queue.queue_running = [entry("a")];
    api.emit("execution_start", { prompt_id: "a" });
    progress(api, "a", 0.25);
    accepted = true;
    return true;
  });
  assert.equal(await result, true);
  assert.equal(accepted, true);
  assert.deepEqual(last(), { phase: "sampling", percent: 25, promptId: "a" });
  progress(api, "a", 0.1); // Reordered stale values cannot reduce measured work.
  assert.equal(last().percent, 25);
  progress(api, "a", 1, "complete");
  assert.equal(last().phase, "saving");
  assert.equal(last().percent, 99);
  api.emit("execution_success", { prompt_id: "a" });
  assert.equal(last().phase, "complete");
  assert.equal(last().percent, 100);
});

test("legacy Prompter IDs never receive DMAI NODES progress", async (t) => {
  const { api, last } = setup(t);
  const job = entry("legacy");
  job[2][1].class_type = "DMAIPrompter";
  api.queue.queue_running = [job];
  api.emit("execution_start", { prompt_id: "legacy" });
  progress(api, "legacy", 0.5);
  await settle();
  assert.deepEqual(last(), { phase: "idle", percent: 0 });
});

test("global Run works and unrelated workflow IDs, clients, and engine IDs do not light this node", async (t) => {
  const { api, last } = setup(t);
  api.queue.queue_running = [entry("other", "workflow-b")];
  api.emit("execution_start", { prompt_id: "other" });
  progress(api, "other", 0.8);
  await settle();
  assert.equal(last().phase, "idle");
  api.queue.queue_running = [entry("foreign", "workflow-a", { clientId: "client-b" })];
  api.emit("execution_start", { prompt_id: "foreign" });
  await settle();
  assert.equal(last().phase, "idle");
  api.queue.queue_running = [entry("local")];
  api.emit("execution_start", { prompt_id: "local" });
  await settle();
  assert.equal(last().phase, "loading");
  progress(api, "local", 0.95, "sampling", "wrong-engine");
  assert.equal(last().percent, 0);
  progress(api, "local", 0.45);
  assert.equal(last().percent, 45);
});

test("cached jobs that finish before queue lookup recover exact history identity", async (t) => {
  const { api, last } = setup(t);
  api.history.cached = { cached: { prompt: entry("cached") } };
  api.emit("execution_start", { prompt_id: "cached" });
  api.emit("execution_cached", { prompt_id: "cached", nodes: ["1", "3", "4"] });
  api.emit("execution_success", { prompt_id: "cached" });
  await settle();
  assert.equal(last().phase, "complete");
  assert.equal(last().percent, 100);
  assert.equal(api.calls.filter((path) => path === "/queue").length, 1);
});

test("fast cached completion retries history briefly while the server finishes recording it", async (t) => {
  const { api, last } = setup(t);
  let historyReads = 0;
  const original = api.fetchApi.bind(api);
  api.fetchApi = async (path) => {
    if (path === "/history/fast" && ++historyReads >= 3) api.history.fast = { fast: { prompt: entry("fast") } };
    return original(path);
  };
  api.emit("execution_start", { prompt_id: "fast" });
  api.emit("execution_success", { prompt_id: "fast" });
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(last().phase, "complete");
  assert.equal(historyReads, 3);
});

test("global Run marks a job waiting behind another workflow as queued", async (t) => {
  const { api, last } = setup(t);
  api.queue.queue_running = [entry("other", "workflow-b")];
  api.queue.queue_pending = [entry("waiting")];
  api.emit("promptQueued", { number: 0, batchCount: 1 });
  await settle();
  assert.equal(last().phase, "queued");
  assert.equal(last().promptId, "waiting");
});

test("only engines reachable from executed outputs contribute; two branches share progress", async (t) => {
  const { api, last } = setup(t);
  const extraNodes = {
    5: { class_type: "DMAIGenerationEngine", inputs: { request: ["1", 0] } },
    6: { class_type: "DMAIGallery", inputs: { images: ["5", 0] } },
    7: { class_type: "DMAIGenerationEngine", inputs: { request: ["1", 0] } },
  };
  api.queue.queue_running = [entry("a", "workflow-a", { extraNodes, outputs: ["4", "6"] })];
  api.emit("execution_start", { prompt_id: "a" });
  await settle();
  progress(api, "a", 1, "complete");
  assert.equal(last().percent, 50);
  api.emit("execution_cached", { prompt_id: "a", nodes: ["5"] });
  assert.equal(last().percent, 99);
  assert.equal(last().phase, "saving");
});

test("nested execution paths resolve exact Prompter instances and workflow switching blocks stale updates", async (t) => {
  const { api, node, state, last } = setup(t);
  const nested = { id: 65, subgraph: graph("subgraph-definition", [node]) };
  state.root = graph("workflow-a", [nested]);
  api.queue.queue_running = [entry("nested", "workflow-a", { source: "65:1", engine: "65:3" })];
  api.emit("execution_start", { prompt_id: "nested" });
  await settle();
  progress(api, "nested", 0.5, "sampling", "65:3");
  assert.equal(last().percent, 50);
  state.root = graph("workflow-b", [{ id: 1 }]);
  progress(api, "nested", 0.9, "sampling", "65:3");
  assert.equal(last().phase, "idle");
  api.emit("execution_success", { prompt_id: "nested" });
  assert.equal(last().phase, "idle");
});

test("false or failed submission leaves no queued glow; no connected engine is reported", async (t) => {
  const { manager, node, last } = setup(t);
  await assert.rejects(manager.generate(node, async () => false), /did not accept/);
  assert.equal(last().phase, "error");
  await assert.rejects(manager.generate(node, async () => { throw new Error("Server unavailable"); }), /Server unavailable/);
  assert.equal(last().message, "Server unavailable");
  await assert.rejects(manager.generate(node, async () => true), /No connected Generation Engine/);
  assert.equal(last().phase, "error");
});

test("error and interruption preserve measured progress below 100 and ignore late success", async (t) => {
  const { api, last } = setup(t);
  api.queue.queue_running = [entry("failed")];
  api.emit("execution_start", { prompt_id: "failed" });
  await settle();
  progress(api, "failed", 0.6);
  progress(api, "failed", 0.6, "error");
  api.emit("execution_error", { prompt_id: "failed", exception_message: "Missing VAE" });
  assert.equal(last().phase, "error");
  assert.equal(last().message, "Missing VAE");
  assert.equal(last().percent, 60);
  api.emit("execution_success", { prompt_id: "failed" });
  assert.equal(last().phase, "error");
  api.queue.queue_running = [entry("stopped")];
  api.emit("execution_start", { prompt_id: "stopped" });
  await settle();
  progress(api, "stopped", 0.3);
  api.emit("execution_interrupted", { prompt_id: "stopped" });
  assert.equal(last().phase, "interrupted");
  assert.equal(last().percent, 30);
});

test("a queued second job survives first-job completion and stale events cannot overwrite it", async (t) => {
  const { api, manager, node, last } = setup(t);
  api.queue.queue_running = [entry("first")];
  api.emit("execution_start", { prompt_id: "first" });
  await settle();
  await manager.generate(node, async () => { api.queue.queue_pending = [entry("second")]; return true; });
  progress(api, "first", 0.5);
  assert.equal(last().promptId, "first");
  api.emit("execution_success", { prompt_id: "first" });
  assert.equal(last().phase, "queued");
  assert.equal(last().promptId, "second");
  api.emit("execution_start", { prompt_id: "second" });
  progress(api, "second", 0.2);
  progress(api, "first", 0.9);
  assert.equal(last().promptId, "second");
  assert.equal(last().percent, 20);
});

test("clearing a pending job stops its queued glow without inventing completion", async (t) => {
  const { api, manager, node, last } = setup(t);
  await manager.generate(node, async () => { api.queue.queue_pending = [entry("removed")]; return true; });
  assert.equal(last().phase, "queued");
  api.queue.queue_pending = [];
  api.emit("status", { exec_info: { queue_remaining: 0 } });
  await new Promise((resolve) => setTimeout(resolve, 240));
  assert.equal(last().phase, "interrupted");
  assert.equal(last().percent, 0);
});

test("queue-clear reconciliation does not overwrite a fast cached job's success", async (t) => {
  const { api, manager, node, last } = setup(t);
  await manager.generate(node, async () => { api.queue.queue_pending = [entry("fast")]; return true; });
  api.queue.queue_pending = [];
  api.emit("status", { exec_info: { queue_remaining: 0 } });
  await settle();
  api.emit("execution_success", { prompt_id: "fast" });
  await new Promise((resolve) => setTimeout(resolve, 65));
  assert.equal(last().phase, "complete");
  assert.equal(last().percent, 100);
});

test("disconnect, unwatch and disposal stop updates and clean event listeners", async (t) => {
  const { api, manager, last, stop, seen } = setup(t);
  api.queue.queue_running = [entry("a")];
  api.emit("execution_start", { prompt_id: "a" });
  await settle();
  progress(api, "a", 0.4);
  api.emit("reconnecting");
  assert.equal(last().phase, "error");
  assert.match(last().message, /Connection lost/);
  assert.equal(last().percent, 40);
  stop();
  const count = seen.length;
  progress(api, "a", 0.9);
  await settle();
  assert.equal(seen.length, count);
  manager.dispose();
  manager.start();
  api.emit("execution_start", { prompt_id: "new" });
  assert.equal(manager.jobs.size, 0);
  assert.equal(manager.listeners.length, 0);
});
