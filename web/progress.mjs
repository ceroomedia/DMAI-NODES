import { PROMPTER_TYPE } from "./workflow-migration.mjs?v=0.2.0";

// Job identity comes from the submitted API graph, never the current selection.
const IDLE = Object.freeze({ phase: "idle", percent: 0 });
const ACTIVE = new Set(["queued", "loading", "sampling", "decoding", "saving"]);
const PHASES = { preparing: "loading", sampling: "sampling", decoding: "decoding", finalizing: "saving", complete: "saving" };
const MAX_JOBS = 64;

function resolveNode(root, executionId) {
  const parts = String(executionId).split(":");
  let graph = root;
  for (let index = 0; index < parts.length; index++) {
    const node = graph?.getNodeById?.(parts[index]);
    if (!node) return null;
    if (index === parts.length - 1) return node;
    graph = node.subgraph;
  }
  return null;
}

function connections(entry) {
  if (!Array.isArray(entry) || entry.length < 5) return null;
  const [, id, prompt, extra, outputs] = entry;
  const workflowId = extra?.extra_pnginfo?.workflow?.id;
  if (typeof workflowId !== "string" || !workflowId || !prompt || typeof prompt !== "object" || !Array.isArray(outputs)) return null;
  const reachable = new Set(), pending = outputs.map(String);
  while (pending.length) {
    const nodeId = pending.pop();
    if (reachable.has(nodeId) || !prompt[nodeId]) continue;
    reachable.add(nodeId);
    for (const value of Object.values(prompt[nodeId].inputs ?? {})) {
      if (Array.isArray(value) && value.length === 2 && prompt[String(value[0])]) pending.push(String(value[0]));
    }
  }
  const sources = new Map();
  for (const engineId of reachable) {
    const engine = prompt[engineId], link = engine.inputs?.request;
    if (engine.class_type !== "DMAIGenerationEngine" || !Array.isArray(link)) continue;
    const sourceId = String(link[0]);
    if (prompt[sourceId]?.class_type !== PROMPTER_TYPE) continue;
    if (!sources.has(sourceId)) sources.set(sourceId, new Set());
    sources.get(sourceId).add(engineId);
  }
  return { id: String(id), workflowId, sources, clientId: extra?.client_id };
}

export class GenerationProgress {
  constructor({ api, getRootGraph }) {
    this.api = api;
    this.getRootGraph = getRootGraph;
    this.records = new Map();
    this.jobs = new Map();
    this.listeners = [];
    this.timers = new Map();
    this.epoch = 0;
    this.sequence = 0;
    this.disposed = false;
  }

  start() {
    if (this.listeners.length || this.disposed) return;
    const listen = (name, handler) => {
      const listener = (event) => handler(event.detail ?? {});
      this.api.addEventListener(name, listener);
      this.listeners.push([name, listener]);
    };
    listen("execution_start", (data) => {
      const job = this.job(data.prompt_id);
      if (!job || job.terminal) return;
      job.started = true;
      void this.lookup(job);
      this.renderJob(job);
    });
    listen("dmai_generation_progress", (data) => {
      const job = this.job(data.prompt_id);
      if (!job || job.terminal || data.node_id == null) return;
      job.started = true;
      const engineId = String(data.node_id), previous = job.progress.get(engineId);
      if (typeof data.fraction !== "number" || !Number.isFinite(data.fraction)) return;
      job.progress.set(engineId, {
        fraction: Math.max(previous?.fraction ?? 0, Math.min(1, Math.max(0, data.fraction))),
        phase: PHASES[data.phase] ?? "loading",
      });
      if (data.phase === "error" || data.phase === "interrupted") job.terminal = data.phase;
      if (!job.context) void this.lookup(job);
      this.renderJob(job);
    });
    listen("execution_cached", (data) => {
      const job = this.job(data.prompt_id);
      if (!job || job.terminal) return;
      for (const id of data.nodes ?? []) job.cached.add(String(id));
      if (!job.context) void this.lookup(job);
      this.renderJob(job);
    });
    listen("promptQueued", () => {
      const epoch = this.epoch;
      void this.read("/queue").then((queue) => {
        if (!this.disposed && epoch === this.epoch) this.captureQueue(queue);
      });
    });
    listen("status", (data) => {
      if (Number.isFinite(data?.exec_info?.queue_remaining)) void this.reconcilePending();
    });
    for (const [event, phase] of [["execution_success", "complete"], ["execution_error", "error"], ["execution_interrupted", "interrupted"]]) {
      listen(event, (data) => {
        const job = this.job(data.prompt_id);
        if (!job) return;
        // A success event must never overwrite an already observed failure.
        if (phase === "complete" && (job.terminal === "error" || job.terminal === "interrupted")) return;
        job.terminal = phase;
        job.message = phase === "error" ? data.exception_message || "Generation failed." : undefined;
        void this.lookup(job, true);
        this.renderJob(job);
      });
    }
    listen("reconnecting", () => this.disconnect());
  }

  watch(node, callback) {
    if (this.disposed) return () => {};
    let record = this.records.get(node);
    if (!record) {
      record = { node, callbacks: new Set(), state: IDLE, submission: null };
      this.records.set(node, record);
      for (const job of this.jobs.values()) if (!job.terminal) this.bind(job);
    }
    record.callbacks.add(callback);
    callback(record.state);
    this.renderRecord(record);
    return () => {
      record.callbacks.delete(callback);
      if (!record.callbacks.size) {
        this.records.delete(node);
        for (const job of this.jobs.values()) job.bindings.delete(record);
      }
    };
  }

  async generate(node, queueFn) {
    this.start();
    const record = this.records.get(node);
    if (!record || this.disposed) throw new Error("The Prompter is no longer available.");
    const token = {};
    const submittedAfter = this.sequence;
    record.submission = token;
    this.publish(record, { phase: "queued", percent: 0 });
    try {
      const accepted = await queueFn();
      if (accepted === false) throw new Error("ComfyUI did not accept the generation request. Check its validation messages.");
      // Also capture jobs waiting behind another workflow, before execution_start.
      const epoch = this.epoch;
      const queue = await this.read("/queue");
      if (epoch === this.epoch && !this.disposed) this.captureQueue(queue);
      if (record.submission === token) record.submission = null;
      const lookups = [...this.jobs.values()].map((job) => job.lookup).filter(Boolean);
      await Promise.allSettled(lookups);
      this.renderRecord(record);
      // Successful queue submission need not mean this Prompter was connected.
      if (![...this.jobs.values()].some((job) => job.order > submittedAfter && job.bindings.has(record))) {
        throw new Error("No connected Generation Engine was queued for this Prompter.");
      }
      return accepted;
    } catch (error) {
      if (record.submission === token) record.submission = null;
      if (this.records.get(node) === record && !this.disposed) {
        this.publish(record, { phase: "error", percent: 0, message: error?.message ?? String(error) });
      }
      throw error;
    }
  }

  job(id) {
    if (this.disposed || typeof id !== "string" || !id) return null;
    let job = this.jobs.get(id);
    if (!job) {
      job = { id, order: ++this.sequence, started: false, terminal: null, context: null, bindings: new Map(), progress: new Map(), cached: new Set(), lookup: null, queueRead: false, historyRead: false };
      this.jobs.set(id, job);
      while (this.jobs.size > MAX_JOBS) this.jobs.delete(this.jobs.keys().next().value);
    }
    return job;
  }

  async read(path) {
    try {
      const response = await this.api.fetchApi(path);
      return response.ok ? await response.json() : null;
    } catch { return null; }
  }

  async reconcilePending() {
    if (this.reconciling || this.disposed) return;
    const pending = [...this.jobs.values()].filter((job) => !job.started && !job.terminal && job.bindings.size);
    if (!pending.length) return;
    const epoch = this.epoch;
    const current = (job) => !this.disposed && epoch === this.epoch && this.jobs.get(job.id) === job && !job.started && !job.terminal;
    this.reconciling = true;
    try {
      const queue = await this.read("/queue");
      if (!queue || this.disposed || epoch !== this.epoch) return;
      this.captureQueue(queue);
      const present = new Set([...(queue.queue_running ?? []), ...(queue.queue_pending ?? [])].map((entry) => String(entry[1])));
      await Promise.all(pending.filter((job) => !present.has(job.id)).map(async (job) => {
        // Start/success can be delivered while a cached job moves into history.
        // Give those authoritative events a short, bounded chance to arrive.
        let historyEntry;
        for (const delay of [50, 150]) {
          await this.delay(delay);
          if (!current(job)) return;
          const history = await this.read(`/history/${encodeURIComponent(job.id)}`);
          if (!current(job)) return;
          historyEntry = history?.[job.id];
        }
        if (!current(job)) return;
        if (historyEntry) {
          // History proves it left the queue, but an absent success event must
          // not fabricate a finished border. The normal history UI has results.
          job.terminal = "error";
          job.message = "The job has left the queue. Check ComfyUI's history for its result.";
        } else job.terminal = "interrupted";
        this.renderJob(job);
      }));
    } finally { this.reconciling = false; }
  }

  captureQueue(queue) {
    for (const [name, started] of [["queue_running", true], ["queue_pending", false]]) {
      for (const entry of queue?.[name] ?? []) {
        const context = connections(entry);
        if (!context) continue;
        const job = this.job(context.id);
        if (!job) continue;
        job.started ||= started;
        this.setContext(job, context);
      }
    }
  }

  setContext(job, context) {
    if (this.api.clientId && context.clientId && context.clientId !== this.api.clientId) return;
    job.context = context;
    this.bind(job);
    this.renderJob(job);
  }

  bind(job) {
    const root = this.getRootGraph?.(), context = job.context;
    if (!root || !context || String(root.id) !== context.workflowId) return;
    for (const [sourceId, engines] of context.sources) {
      const node = resolveNode(root, sourceId), record = this.records.get(node);
      if (record) job.bindings.set(record, { sourceId, engines, workflowId: context.workflowId });
    }
  }

  async lookup(job, terminal = false) {
    if (job.context || this.disposed) return;
    if (job.lookup) {
      await job.lookup;
      if (terminal && !job.context) return this.lookup(job, true);
      return;
    }
    if (terminal && job.historyRead) return;
    if (!terminal && job.queueRead) return;
    const epoch = this.epoch;
    const current = () => !this.disposed && epoch === this.epoch && this.jobs.get(job.id) === job;
    job.lookup = (async () => {
      if (!job.queueRead) {
        job.queueRead = true;
        const queue = await this.read("/queue");
        if (!current()) return;
        this.captureQueue(queue);
      }
      if (job.context) return;
      // A fast cached job can leave the queue before its start event is handled.
      job.historyRead ||= terminal;
      for (const delay of terminal ? [0, 50, 150] : [0]) {
        if (delay) await this.delay(delay);
        if (!current()) return;
        const history = await this.read(`/history/${encodeURIComponent(job.id)}`);
        if (!current()) return;
        const context = connections(history?.[job.id]?.prompt);
        if (context) { this.setContext(job, context); return; }
      }
    })();
    try { await job.lookup; } finally { job.lookup = null; }
  }

  delay(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.timers.delete(timer); resolve(); }, ms);
      this.timers.set(timer, resolve);
    });
  }

  stateFor(job, binding) {
    const engines = [...binding.engines];
    const fractions = engines.map((id) => job.cached.has(id) ? 1 : job.progress.get(id)?.fraction ?? 0);
    const fraction = fractions.reduce((total, value) => total + value, 0) / Math.max(1, engines.length);
    let phase = job.started ? "loading" : "queued";
    if (job.terminal) phase = job.terminal;
    else if (fraction === 1) phase = "saving";
    else {
      for (const id of engines) {
        const progress = job.progress.get(id);
        if (progress && progress.fraction < 1) phase = progress.phase;
      }
    }
    return { phase, percent: phase === "complete" ? 100 : Math.min(99, fraction * 100), promptId: job.id, ...(job.message ? { message: job.message } : {}) };
  }

  validBinding(record, binding) {
    const root = this.getRootGraph?.();
    return root && String(root.id) === binding.workflowId && resolveNode(root, binding.sourceId) === record.node;
  }

  renderRecord(record) {
    if (this.records.get(record.node) !== record) return;
    const matches = [...this.jobs.values()].filter((job) => job.bindings.has(record) && this.validBinding(record, job.bindings.get(record)));
    matches.sort((a, b) => {
      const priority = (job) => job.terminal ? 0 : job.started ? 2 : 1;
      return priority(b) - priority(a) || b.order - a.order;
    });
    if (matches.length) this.publish(record, this.stateFor(matches[0], matches[0].bindings.get(record)));
    else if (record.submission) this.publish(record, { phase: "queued", percent: 0 });
    else if (ACTIVE.has(record.state.phase)) this.publish(record, IDLE);
  }

  renderJob(job) {
    for (const record of job.bindings.keys()) this.renderRecord(record);
  }

  publish(record, state) {
    if (this.disposed || !record.callbacks.size) return;
    if (JSON.stringify(record.state) === JSON.stringify(state)) return;
    record.state = state;
    for (const callback of record.callbacks) callback(state);
  }

  disconnect() {
    this.epoch++;
    this.jobs.clear();
    this.clearTimers();
    for (const record of this.records.values()) {
      record.submission = null;
      if (ACTIVE.has(record.state.phase)) this.publish(record, { phase: "error", percent: Math.min(99, record.state.percent), message: "Connection lost. Check the ComfyUI queue before generating again." });
    }
  }

  clearTimers() {
    for (const [timer, resolve] of this.timers) { clearTimeout(timer); resolve(); }
    this.timers.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    for (const [name, listener] of this.listeners) this.api.removeEventListener(name, listener);
    this.listeners = [];
    this.clearTimers();
    this.jobs.clear();
    this.records.clear();
  }
}
