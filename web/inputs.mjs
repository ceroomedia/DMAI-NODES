import {
  Controller,
  el,
  button,
  input,
  details,
  statusMessage,
} from "./dom.mjs?v=0.2.0";
import {
  RATIOS,
  dimensions,
  customDimensions,
  readPrompt,
  readManifest,
  moveEntry,
  uid,
} from "./core.mjs?v=0.2.0";
import { ProgressView, progressPresentation } from "./progress-view.mjs?v=0.2.0";

export class Prompter extends Controller {
  constructor(node, context) {
    super(node, "config_json", "Prompter", "text", context);
    this.root.classList.add("dmai-prompter");
    const scroll = el("div", "dmai-prompter-scroll");
    scroll.append(...this.root.childNodes);
    this.root.append(scroll);
    this.progress = { phase: "idle", percent: 0 };
    this.progressView = new ProgressView(this.root);
    this.size(460, 690);
    this.hydrate();
    this.stopProgress = context.watchProgress?.(node, (state) => {
      if (!this.disposed) this.updateProgress(state);
    });
  }
  hydrate() {
    if (this.disposed) return;
    try {
      this.value = readPrompt(this.native.value);
      this.note();
      this.build();
    } catch (error) {
      this.invalid(error);
    }
  }
  persist() {
    this.set(this.value);
  }
  build() {
    this.body.replaceChildren();
    const prompt = el("textarea", "dmai-prompt");
    prompt.placeholder = "Describe your image…";
    prompt.value = this.value.prompt;
    prompt.setAttribute("aria-label", "Image description");
    prompt.addEventListener("input", () => {
      this.value.prompt = prompt.value;
      this.persist();
    });
    const promptField = el("label", "dmai-prompt-field");
    promptField.append(el("span", "dmai-section-label", "Prompt"), prompt);
    this.body.append(promptField);
    const settings = el("div", "dmai-prompt-settings"),
      format = el("div", "dmai-format-section");
    format.append(el("span", "dmai-section-label", "Aspect ratio"));
    this.ratioRow = el("div", "dmai-ratios");
    this.ratioRow.setAttribute("role", "group");
    this.ratioRow.setAttribute("aria-label", "Aspect ratio");
    for (const ratio of ["1:1", "4:5", "9:16", "16:9"])
      this.ratioRow.append(this.ratioButton(ratio));
    const moreRatios = button("More", "more", () => this.showRatios(), true);
    moreRatios.classList.add("dmai-ratio-more");
    moreRatios.setAttribute("aria-label", "All 19 aspect ratios");
    moreRatios.title = "All 19 aspect ratios";
    this.ratioRow.append(moreRatios);
    format.append(this.ratioRow);
    settings.append(format);
    const resolutionRow = el("div", "dmai-resolution"),
      group = el("div", "dmai-segmented");
    this.resolutionButtons = {};
    for (const r of ["1K", "2K", "Custom"]) {
      const b = button(
        r,
        r === "Custom" ? "frame" : null,
        () => (r === "Custom" ? this.custom() : this.chooseResolution(r)),
        true,
      );
      this.resolutionButtons[r] = b;
      group.append(b);
    }
    this.dimensions = el("output", "dmai-dimensions");
    resolutionRow.append(group, this.dimensions);
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Resolution");
    this.dimensions.setAttribute("aria-label", "Image dimensions");
    settings.append(resolutionRow);
    const countRow = el("div", "dmai-row dmai-count");
    countRow.append(el("span", "dmai-section-label", "Images"));
    this.less = button("One fewer image", "minus", () => this.count(-1));
    this.more = button("One more image", "plus", () => this.count(1));
    this.countOutput = el("output");
    this.countOutput.setAttribute("aria-label", "Image count");
    const stepper = el("div", "dmai-stepper");
    stepper.append(this.less, this.countOutput, this.more);
    countRow.append(stepper);
    settings.append(countRow);
    this.body.append(settings);
    const advanced = details("Negative prompt");
    const negative = el("textarea", "dmai-negative");
    negative.value = this.value.negative_prompt;
    negative.placeholder = "Negative prompt";
    negative.setAttribute("aria-label", "Negative prompt");
    negative.addEventListener("input", () => {
      this.value.negative_prompt = negative.value;
      this.persist();
    });
    advanced.body.append(negative);
    this.body.append(advanced.root);
    this.runButton = button(
      "Generate",
      "play",
      () => this.generate(),
      true,
    );
    this.runButton.classList.add("dmai-primary", "dmai-generate");
    this.body.append(this.runButton, this.progressView.readout);
    this.sync();
    this.renderProgress();
  }
  updateProgress(state) {
    if (this.progress?.phase === "error" && progressPresentation(state).busy)
      this.note();
    this.progress = state;
    if (state.phase === "error" && state.message)
      this.error(new Error(state.message));
    this.renderProgress();
  }
  renderProgress() {
    const view = this.progressView.update(this.progress);
    if (this.runButton) this.runButton.disabled = Boolean(this.queuePending || view.busy);
  }
  async generate() {
    if (this.queuePending || progressPresentation(this.progress).busy || this.disposed) return;
    return this.guard(async () => {
      this.queuePending = true;
      this.note();
      this.renderProgress();
      try {
        await this.context.generate(this.node);
      } catch (error) {
        this.updateProgress({
          phase: "error",
          percent: this.progress?.percent ?? 0,
          message: error?.message ?? String(error),
        });
        throw error;
      } finally {
        this.queuePending = false;
        if (!this.disposed) this.renderProgress();
      }
    });
  }
  dispose() {
    if (this.disposed) return;
    this.stopProgress?.();
    this.progressView?.dispose();
    super.dispose();
  }
  intent() {
    const v = this.node.properties?.dmai_format;
    if (v && RATIOS.includes(v.ratio) && ["1K", "2K"].includes(v.resolution)) {
      const [w, h] = dimensions(v.ratio, v.resolution);
      if (w === this.value.width && h === this.value.height) return v;
    }
    return { ratio: "4:5", resolution: "Custom" };
  }
  remember(ratio, resolution) {
    this.node.properties ??= {};
    this.node.properties.dmai_format = { ratio, resolution };
  }
  ratioButton(ratio) {
    const b = button(ratio, null, () => this.chooseRatio(ratio), true),
      [w, h] = ratio.split(":").map(Number),
      shape = el("span", "dmai-ratio-shape");
    shape.style.aspectRatio = String(w / h);
    b.prepend(shape);
    b.dataset.ratio = ratio;
    return b;
  }
  chooseRatio(ratio) {
    const intent = this.intent(),
      resolution = intent.resolution === "Custom" ? "1K" : intent.resolution;
    [this.value.width, this.value.height] = dimensions(ratio, resolution);
    this.remember(ratio, resolution);
    this.persist();
    this.sync();
  }
  chooseResolution(resolution) {
    const ratio = this.intent().ratio;
    [this.value.width, this.value.height] = dimensions(ratio, resolution);
    this.remember(ratio, resolution);
    this.persist();
    this.sync();
  }
  sync() {
    const intent = this.intent();
    for (const b of this.ratioRow.querySelectorAll("[data-ratio]"))
      b.setAttribute(
        "aria-pressed",
        String(
          intent.resolution !== "Custom" && intent.ratio === b.dataset.ratio,
        ),
      );
    for (const [r, b] of Object.entries(this.resolutionButtons))
      b.setAttribute("aria-pressed", String(r === intent.resolution));
    this.dimensions.textContent = `${this.value.width} × ${this.value.height}`;
    this.countOutput.textContent = this.value.count;
    this.less.disabled = this.value.count <= 1;
    this.more.disabled = this.value.count >= 8;
  }
  count(delta) {
    this.value.count = Math.max(1, Math.min(8, this.value.count + delta));
    this.persist();
    this.sync();
  }
  showRatios() {
    const d = this.show("Aspect ratio"),
      grid = el("div", "dmai-format-grid");
    for (const ratio of RATIOS) {
      const b = this.ratioButton(ratio);
      b.addEventListener("click", () => d.root.close());
      grid.append(b);
    }
    d.body.append(grid);
  }
  custom() {
    const d = this.show("Custom resolution"),
      grid = el("div", "dmai-custom-size"),
      w = input("Width", "number", this.value.width),
      h = input("Height", "number", this.value.height),
      out = el("output", "dmai-size-output"),
      note = el("p", "dmai-muted"),
      apply = button(
        "Apply size",
        "check",
        () => {
          const values = read();
          if (!values) return;
          [this.value.width, this.value.height] = values;
          this.remember(this.intent().ratio, "Custom");
          this.persist();
          this.sync();
          d.root.close();
        },
        true,
      );
    apply.classList.add("dmai-primary");
    for (const field of [w, h]) {
      field.control.min = 64;
      field.control.max = 8192;
      field.control.step = 1;
      field.control.addEventListener("input", read);
    }
    grid.append(
      w.field,
      button("Swap dimensions", "swap", () => {
        [w.control.value, h.control.value] = [h.control.value, w.control.value];
        read();
      }),
      h.field,
    );
    d.body.append(grid, out, note, apply);
    function read() {
      try {
        const values = customDimensions(
          w.control.value === "" ? NaN : Number(w.control.value),
          h.control.value === "" ? NaN : Number(h.control.value),
        );
        out.textContent = `${values[0]} × ${values[1]} px`;
        note.textContent =
          "Rounded to the nearest 64 px. The engine checks model limits.";
        apply.disabled = false;
        return values;
      } catch (error) {
        out.textContent = "";
        note.textContent = error.message;
        apply.disabled = true;
        return null;
      }
    }
    read();
  }
}

export class LoRAStack extends Controller {
  constructor(node, context) {
    super(node, "manifest_json", "LoRA Loader", "layers", context);
    this.root.classList.add("dmai-lora");
    const serialize = this.native.serializeValue?.bind(this.native);
    this.native.serializeValue = (...args) => {
      if (!this.syncStrengths())
        throw new Error(
          "Correct the highlighted LoRA strength before queueing.",
        );
      readManifest(this.native.value);
      return serialize ? serialize(...args) : this.native.value;
    };
    this.size(480, 520);
    this.hydrate();
  }
  hydrate() {
    if (this.disposed) return;
    try {
      this.value = readManifest(this.native.value);
      this.note();
      this.build();
    } catch (error) {
      this.invalid(error);
    }
  }
  persist() {
    this.set(this.value);
  }
  updateStrength(id, text, channel = "model") {
    if (!["model", "clip"].includes(channel)) return false;
    const value = text.trim() === "" ? NaN : Number(text);
    if (!Number.isFinite(value) || value < -20 || value > 20) {
      this.error(
        new Error(
          `${channel === "clip" ? "CLIP" : "Model"} strength must be from −20 to 20. Correct it before queueing.`,
        ),
      );
      return false;
    }
    const entry = this.value.entries.find((item) => item.id === id);
    if (!entry) return false;
    entry[`strength_${channel}`] = value;
    this.persist();
    this.note();
    this.updateSummary();
    return true;
  }
  syncStrengths() {
    for (const control of this.body.querySelectorAll(".dmai-strength")) {
      if (!this.updateStrength(control.dataset.entryId, control.value, control.dataset.strength ?? "model")) {
        control.setAttribute("aria-invalid", "true");
        control.focus();
        return false;
      }
      control.removeAttribute("aria-invalid");
    }
    return true;
  }
  updateSummary() {
    const count = this.value.entries.filter(
      (entry) => entry.enabled && (entry.strength_model !== 0 || entry.strength_clip !== 0),
    ).length;
    if (this.summary) this.summary.textContent = `${count} active · top to bottom`;
  }
  strengthField(entry, channel) {
    const label = channel === "clip" ? "CLIP" : "Model",
      field = el("label", "dmai-field dmai-lora-strength-field"),
      strength = el("input", "dmai-strength");
    strength.type = "number";
    strength.min = -20;
    strength.max = 20;
    strength.step = 0.05;
    strength.value = entry[`strength_${channel}`];
    strength.dataset.entryId = entry.id;
    strength.dataset.strength = channel;
    strength.setAttribute("aria-label", `${label} strength for ${entry.name}`);
    const commitStrength = () => {
      if (this.updateStrength(entry.id, strength.value, channel))
        strength.removeAttribute("aria-invalid");
      else strength.setAttribute("aria-invalid", "true");
    };
    strength.addEventListener("input", commitStrength);
    strength.addEventListener("change", commitStrength);
    field.append(el("span", "", label), strength);
    return field;
  }
  move(id, to) {
    if (!this.syncStrengths()) return;
    this.value.entries = moveEntry(this.value.entries, id, to);
    this.persist();
    this.build();
    const moved = this.value.entries.find((e) => e.id === id);
    this.note(
      `${moved.name} · position ${this.value.entries.indexOf(moved) + 1}`,
    );
    this.body
      .querySelector(`[data-entry-id="${CSS.escape(id)}"] .dmai-grip`)
      ?.focus();
  }
  build() {
    this.body.replaceChildren();
    const list = el("div", "dmai-lora-list");
    list.setAttribute("role", "list");
    list.setAttribute("aria-label", "Ordered LoRA stack");
    let dragged = null;
    this.value.entries.forEach((entry, index) => {
      const row = el("div", `dmai-nodes-lora-row${entry.enabled ? "" : " dmai-off"}`);
      row.dataset.entryId = entry.id;
      row.setAttribute("role", "listitem");
      const main = el("div", "dmai-lora-main"),
        controls = el("div", "dmai-lora-controls"),
        actions = el("div", "dmai-lora-actions"),
        order = el("span", "dmai-nodes-lora-order", String(index + 1).padStart(2, "0"));
      order.setAttribute("aria-label", `Position ${index + 1}`);
      const grip = button(`Reorder ${entry.name}; Alt and arrow keys`, "grip");
      grip.classList.add("dmai-grip");
      grip.draggable = true;
      grip.addEventListener("keydown", (event) => {
        if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault();
          this.move(entry.id, index + (event.key === "ArrowUp" ? -1 : 1));
        }
      });
      grip.addEventListener("dragstart", (event) => {
        dragged = entry.id;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", entry.id);
        row.classList.add("dmai-dragging");
      });
      grip.addEventListener("dragend", () => {
        dragged = null;
        row.classList.remove("dmai-dragging");
        list
          .querySelectorAll(".dmai-dragover")
          .forEach((r) => r.classList.remove("dmai-dragover"));
      });
      row.addEventListener("dragover", (event) => {
        if (dragged) {
          event.preventDefault();
          row.classList.add("dmai-dragover");
        }
      });
      row.addEventListener("dragleave", () =>
        row.classList.remove("dmai-dragover"),
      );
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        if (dragged) this.move(dragged, index);
        dragged = null;
      });
      const copy = el("div", "dmai-lora-copy"),
        title = el("span", "dmai-nodes-lora-name", entry.name);
      title.title = entry.name;
      copy.append(title);
      const toggle = button(
        `${entry.enabled ? "Disable" : "Enable"} ${entry.name}`,
        "power",
        () => {
          if (!this.syncStrengths()) return;
          entry.enabled = !entry.enabled;
          this.persist();
          this.build();
        },
      );
      toggle.setAttribute("aria-pressed", String(entry.enabled));
      const arrows = el("div", "dmai-reorder");
      arrows.setAttribute("role", "group");
      arrows.setAttribute("aria-label", `Order for ${entry.name}`);
      const up = button(`Move ${entry.name} up`, "up", () =>
          this.move(entry.id, index - 1),
        ),
        down = button(`Move ${entry.name} down`, "down", () =>
          this.move(entry.id, index + 1),
        );
      up.disabled = index === 0;
      down.disabled = index === this.value.entries.length - 1;
      arrows.append(up, down);
      const edit = button(`Edit ${entry.name}`, "sliders", () =>
        this.edit(entry),
      );
      actions.append(toggle, edit);
      main.append(grip, order, copy, actions);
      controls.append(this.strengthField(entry, "model"), this.strengthField(entry, "clip"), arrows);
      row.append(main, controls);
      list.append(row);
    });
    if (!this.value.entries.length)
      list.append(el("div", "dmai-empty", "Add a LoRA to build your stack."));
    const add = button("Add LoRA", "plus", () => this.guard(() => this.library()), true);
    add.classList.add("dmai-nodes-lora-add");
    this.summary = el("div", "dmai-footnote");
    this.body.append(list, add, this.summary);
    this.updateSummary();
  }
  edit(entry) {
    if (!this.syncStrengths()) return;
    const d = this.show("LoRA settings"),
      strengths = el("div", "dmai-lora-dialog-strengths"),
      model = input("Model strength", "number", entry.strength_model),
      clip = input("CLIP strength", "number", entry.strength_clip);
    for (const field of [model, clip]) {
      field.control.min = -20;
      field.control.max = 20;
      field.control.step = 0.05;
    }
    strengths.append(model.field, clip.field);
    const message = el("p", "dmai-status"),
      apply = button(
        "Apply",
        "check",
        () => {
          const values = [model, clip].map((field) =>
            field.control.value.trim() === "" ? NaN : Number(field.control.value),
          );
          if (values.some((value) => !Number.isFinite(value) || value < -20 || value > 20)) {
            statusMessage(
              message,
              "Model and CLIP strength must each be from −20 to 20.",
              true,
            );
            return;
          }
          [entry.strength_model, entry.strength_clip] = values;
          this.persist();
          this.build();
          d.root.close();
        },
        true,
      ),
      remove = button(
        "Remove LoRA",
        "close",
        () => {
          this.value.entries = this.value.entries.filter(
            (e) => e.id !== entry.id,
          );
          this.persist();
          this.build();
          d.root.close();
        },
        true,
      );
    d.body.append(
      el("p", "dmai-filename", entry.name),
      strengths,
      message,
      apply,
      remove,
    );
  }
  async library() {
    if (!this.syncStrengths()) return;
    const d = this.show("LoRA library"),
      search = input("Search LoRAs", "search"),
      results = el("div", "dmai-library"),
      message = el("p", "dmai-muted", "Loading LoRAs…");
    d.body.append(search.field, results, message);
    try {
      const data = await this.context.bootstrap(true);
      if (!d.root.isConnected) return;
      const draw = () => {
        results.replaceChildren();
        const entries = data.loras.filter((e) =>
          e.name.toLowerCase().includes(search.control.value.toLowerCase()),
        );
        for (const item of entries) {
          const b = button(
            item.name,
            "plus",
            () => {
              this.value.entries.push({
                id: uid(),
                name: item.name,
                enabled: true,
                strength_model: 1,
                strength_clip: 1,
              });
              this.persist();
              this.build();
              d.root.close();
            },
            true,
          );
          results.append(b);
        }
        message.textContent = entries.length
          ? `${entries.length} available`
          : "No matching LoRAs. Add files to ComfyUI/models/loras and refresh.";
      };
      search.control.addEventListener("input", draw);
      draw();
    } catch (error) {
      message.textContent = error.message;
      message.dataset.error = "true";
    }
  }
}
