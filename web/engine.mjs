import {
  Controller,
  el,
  button,
  input,
  select,
  details,
} from "./dom.mjs?v=0.2.0";
import {
  readEngine,
  validateSettings,
  clone,
  mergePresets,
  envelope,
} from "./core.mjs?v=0.2.0";
import {
  modelSource,
  modelGroups,
  selectedModel,
  parseModelToken,
  profileForSource,
  inventoryName,
} from "./model-picker.mjs?v=0.2.0";

export class Engine extends Controller {
  constructor(node, context) {
    super(node, "config_json", "Generation Engine", "bolt", context);
    this.root.classList.add("dmai-engine");
    this.initializeSize();
    this.wrap("onConnectionsChange", () =>
      queueMicrotask(() => {
        if (!this.disposed && this.value && this.commitControls()) this.build();
      }),
    );
    this.wrap("onExecuted", (output) => {
      const report = Array.isArray(output?.dmai_report)
        ? output.dmai_report[0]
        : output?.dmai_report;
      if (report)
        this.note(
          `${report.request?.count ?? report.images?.length ?? ""} images complete`.trim(),
        );
    });
    this.hydrate();
  }
  initializeSize() {
    let height = 700;
    try {
      if (readEngine(this.native.value).mode === "enhanced") height = 600;
    } catch {
      // hydrate() reports invalid saved data without replacing its value.
    }
    this.size(440, height);
  }
  hydrate() {
    if (this.disposed) return;
    const revision = (this.revision = (this.revision ?? 0) + 1);
    try {
      this.value = readEngine(this.native.value);
      this.note();
      this.build();
      this.guard(async () => {
        const data = await this.context.bootstrap();
        if (!this.disposed && this.revision === revision) {
          this.data = data;
          this.build();
        }
      });
    } catch (error) {
      this.invalid(error);
    }
  }
  persist() {
    this.set(this.value);
  }
  profile() {
    return this.data?.profiles?.find((p) => p.id === this.value.profile_id);
  }
  presets() {
    return [...(this.data?.presets ?? []), ...this.value.presets];
  }
  chosen() {
    return this.presets().find(
      (p) =>
        p.id === this.value.preset_id && p.model.id === this.value.profile_id,
    );
  }
  availablePresets() {
    // The built-in catalog is retained only for saved-workflow compatibility.
    // New choices in the interface are the JSON settings the owner imported.
    const presets = this.value.presets.filter(
      (preset) => preset.model.id === this.value.profile_id,
    );
    const current = this.chosen();
    if (current && !presets.some((preset) => preset.id === current.id))
      presets.unshift(current);
    return presets;
  }
  effective() {
    return this.value.mode === "enhanced"
      ? (this.chosen()?.settings ?? this.value.settings)
      : this.value.settings;
  }
  linked(name) {
    return (
      this.node.inputs?.some(
        (input) => input.name === name && input.link != null,
      ) ?? false
    );
  }
  samplingSummary(settings) {
    return `${this.linked("sampler") ? "Connected sampler" : settings.sampler} / ${this.linked("sigmas") ? "connected sigmas" : settings.scheduler}`;
  }
  drafts() {
    this.node.properties ??= {};
    return (this.node.properties.dmai_engine_drafts ??= {});
  }
  remember() {
    this.drafts()[this.value.profile_id] = clone({
      mode: this.value.mode,
      preset_id: this.value.preset_id,
      settings: this.value.settings,
      models: this.value.models,
    });
    const source = modelSource(this.profile());
    if (source) this.lastProfiles()[source.key] = this.value.profile_id;
  }
  lastProfiles() {
    this.node.properties ??= {};
    return (this.node.properties.dmai_model_profiles ??= {});
  }
  manualDrafts() {
    this.node.properties ??= {};
    return (this.node.properties.dmai_manual_drafts ??= {});
  }
  commitControls() {
    return (this.commitManual?.() ?? true) && (this.commitSeed?.() ?? true);
  }
  applyMode(mode) {
    if (mode === this.value.mode || !this.commitControls()) return;
    if (this.value.mode === "manual")
      this.manualDrafts()[this.value.profile_id] = clone(this.value.settings);
    if (mode === "enhanced") {
      const preset =
        this.chosen() ??
        this.value.presets.find((p) => p.model.id === this.value.profile_id);
      if (preset) {
        this.value.preset_id = preset.id;
        this.value.settings = clone(preset.settings);
      } else {
        // Enhanced must be reachable before a JSON file exists. Execution
        // validates the missing preset, while Manual keeps its separate draft.
        this.value.preset_id = "";
      }
    } else
      this.value.settings = clone(
        this.manualDrafts()[this.value.profile_id] ?? this.effective(),
      );
    this.value.mode = mode;
    this.persist();
    this.build();
  }
  changeProfile(id, selection) {
    if (!this.commitControls()) return false;
    const previousSource = modelSource(this.profile());
    const previousFile = previousSource && this.value.models[previousSource.key];
    this.remember();
    if (this.value.mode === "manual")
      this.manualDrafts()[this.value.profile_id] = clone(this.value.settings);
    const profile = this.data.profiles.find((p) => p.id === id);
    if (!profile) return false;
    const saved = this.drafts()[id],
      models = {
        diffusion_model: "",
        text_encoder: "",
        vae: "",
        checkpoint: "",
      };
    for (const f of profile.model_fields)
      models[f.key] = this.data.models[f.inventory]?.includes(f.default)
        ? f.default
        : "";
    this.value.profile_id = id;
    Object.assign(
      this.value,
      saved
        ? clone(saved)
        : {
            mode: "manual",
            preset_id: "",
            settings: clone(profile.default_settings),
            models,
          },
    );
    const source = modelSource(profile);
    // Architecture changes keep the chosen model file. Crossing categories
    // restores that architecture's encoder/VAE and sampling settings instead.
    if (selection && source?.key === selection.key)
      this.value.models[source.key] = selection.name;
    else if (source?.key === previousSource?.key && previousFile)
      this.value.models[source.key] = previousFile;
    if (source) this.lastProfiles()[source.key] = id;
    this.persist();
    this.build();
    return true;
  }
  chooseModel(selection) {
    if (!this.commitControls()) return false;
    const profile = profileForSource(
      this.data.profiles, selection.key, this.value.profile_id, this.lastProfiles(),
    );
    if (!profile) {
      this.error(new Error("No installed architecture adapter supports this model category."));
      return false;
    }
    if (profile.id !== this.value.profile_id)
      return this.changeProfile(profile.id, selection);
    this.value.models[selection.key] = selection.name;
    this.persist();
    this.build();
    return true;
  }
  changeModelFile(key, name) {
    if (!this.commitControls()) return false;
    this.value.models[key] = name;
    this.persist();
    this.build();
    return true;
  }
  modelPicker(profile) {
    const groups = modelGroups(this.data?.models);
    const selected = selectedModel(profile, this.value.models, this.data?.models);
    const hasFiles = groups.some((group) => group.items.length);
    const picker = select("Model", [{ value: "", label: !this.data
      ? "Loading installed models…"
      : hasFiles ? "Choose an installed model" : "No installed models found" }], "");
    picker.field.classList.add("dmai-model");
    for (const group of groups) {
      if (!group.items.length) continue;
      const element = el("optgroup");
      element.label = group.label;
      for (const item of group.items)
        element.append(new Option(item.label, item.value));
      picker.control.append(element);
    }
    if (selected && !selected.available)
      picker.control.append(new Option(`${selected.name} · unavailable`, selected.value));
    picker.control.value = selected?.value ?? "";
    picker.control.disabled = !this.data || ["model", "clip", "vae"].every((name) => this.linked(name));
    picker.control.addEventListener("change", () => {
      if (!picker.control.value) {
        if (this.commitControls()) {
          const source = modelSource(this.profile());
          if (source) this.value.models[source.key] = "";
          this.persist();
          this.build();
        }
      } else this.chooseModel(parseModelToken(picker.control.value));
      picker.control.value = selectedModel(this.profile(), this.value.models, this.data?.models)?.value ?? "";
    });
    return picker.field;
  }
  fitHeight(profile) {
    const current = this.node.size?.[1] ?? 0,
      previousMinimum = Math.max(this.minimumSize()[1], this.node.computeSize?.()?.[1] ?? 0);
    // Remember an explicit larger size across automatic growth (for example,
    // a Krea enhancer row), so changing modes cannot erase the user's height.
    if (this.lastEngineHeight === undefined || Math.abs(current - this.lastEngineHeight) > 2)
      this.preferredEngineHeight = current > previousMinimum + 2 ? current : undefined;
    this.minHeight = this.value.mode === "enhanced" ? 600 : profile?.family === "krea2" ? 770 : 700;
    const minimum = this.minimumSize(),
      height = Math.max(minimum[1], this.node.computeSize?.()?.[1] ?? 0, this.preferredEngineHeight ?? 0),
      width = Math.max(minimum[0], this.node.size?.[0] ?? 0);
    if (height !== current || width !== this.node.size?.[0])
      this.node.setSize?.([width, height]);
    this.positionSlots();
    this.lastEngineHeight = this.node.size?.[1] ?? height;
  }
  build() {
    this.modelFilesExpanded = this.modelFilesDetails?.open ?? this.modelFilesExpanded;
    this.body.replaceChildren();
    this.commitManual = null;
    this.commitSeed = null;
    const profile = this.profile(),
      s = this.effective();
    this.fitHeight(profile);
    this.body.append(this.modelPicker(profile));
    if (["model", "clip", "vae"].every((name) => this.linked(name)))
      this.body.append(el("div", "dmai-badge", "Connected model · CLIP · VAE"));
    this.modelFiles(profile);
    const mode = el("div", "dmai-segmented dmai-mode");
    for (const [value, label, glyph] of [
      ["manual", "Manual", "sliders"],
      ["enhanced", "DMAI Enhanced", "spark"],
    ]) {
      const b = button(label, glyph, () => this.applyMode(value), true);
      b.setAttribute("aria-pressed", String(this.value.mode === value));
      b.disabled = !this.data;
      mode.append(b);
    }
    this.body.append(mode);
    if (this.value.mode === "manual") this.manual(s, profile);
    else this.enhanced(s);
    if (this.linked("sampler") || this.linked("sigmas"))
      this.body.append(
        el(
          "p",
          "dmai-muted",
          this.linked("sigmas")
            ? "Steps, schedule and denoise come from connected sigmas."
            : "Using the connected sampler with these steps and schedule.",
        ),
      );
    if (this.linked("latent"))
      this.body.append(
        el("p", "dmai-muted", "Connected latent supplies image dimensions."),
      );
    const seedRow = el("div", "dmai-seed"),
      seed = input("Seed", "text", this.value.seed);
    seed.control.inputMode = "numeric";
    this.commitSeed = () => {
      if (
        !/^\d{1,20}$/.test(seed.control.value) ||
        BigInt(seed.control.value) > 18446744073709551615n
      ) {
        seed.control.setAttribute("aria-invalid", "true");
        this.error(
          new Error("Seed must be an integer from 0 to 18446744073709551615."),
        );
        return false;
      }
      const n = Number(seed.control.value);
      this.value.seed = Number.isSafeInteger(n) ? n : seed.control.value;
      seed.control.removeAttribute("aria-invalid");
      this.persist();
      return true;
    };
    seed.control.addEventListener("change", () => {
      if (this.commitSeed()) this.note();
    });
    seedRow.append(
      seed.field,
      button("Random seed", "dice", () => {
        this.value.seed = crypto.getRandomValues(new Uint32Array(1))[0];
        seed.control.value = this.value.seed;
        this.persist();
      }),
    );
    this.body.append(seedRow);
    if (this.data && !profile)
      this.error(
        new Error(
          "This model profile is not installed. Choose a supported architecture.",
        ),
      );
  }
  enhanced(settings) {
    const panel = el("section", "dmai-enhanced"),
      preset = this.chosen(),
      choices = this.availablePresets();
    panel.setAttribute("aria-label", "DMAI Enhanced settings");
    if (choices.length > 1) {
      const picker = select(
        "DMAI settings",
        choices.map((entry) => ({ value: entry.id, label: entry.name })),
        this.value.preset_id,
      );
      picker.control.addEventListener("change", () => {
        if (!this.selectPreset(picker.control.value))
          picker.control.value = this.value.preset_id;
      });
      panel.append(picker.field);
    } else {
      const title = el("div", "dmai-enhanced-title", preset?.name ?? "Your DMAI settings");
      if (preset)
        title.title = this.value.presets.some((entry) => entry.id === preset.id)
          ? "Imported settings" : "Saved workflow settings";
      panel.append(title);
      if (!preset)
        panel.append(el("p", "dmai-enhanced-copy", "Upload a DMAI JSON file for this model."));
    }
    if (preset) {
      panel.append(
        el("div", "dmai-enhanced-summary", `${this.linked("sigmas") ? "Connected sigmas" : `${settings.steps} steps`} · CFG ${settings.cfg}`),
        el("div", "dmai-enhanced-sampling", this.samplingSummary(settings)),
      );
      if (settings.enhancer === "krea2t")
        panel.append(el("div", "dmai-badge", "Krea enhancer enabled"));
    }
    const file = el("input");
    file.type = "file";
    file.accept = ".json,application/json";
    file.hidden = true;
    file.addEventListener("change", () =>
      this.guard(async () => {
        try {
          const selected = file.files?.[0];
          if (selected) await this.importFile(selected);
        } finally {
          file.value = "";
        }
      }),
    );
    const actions = el("div", "dmai-enhanced-actions"),
      upload = button("Upload JSON", "upload", () => file.click(), true);
    upload.disabled = !this.data;
    actions.append(upload, file);
    if (this.value.presets.length)
      actions.append(button("Manage imported settings", "layers", () => this.managePresets()));
    panel.append(actions);
    this.body.append(panel);
  }
  selectPreset(id) {
    const preset = this.availablePresets().find((entry) => entry.id === id);
    if (!preset || !this.commitControls()) return false;
    this.value.mode = "enhanced";
    this.value.preset_id = preset.id;
    this.value.settings = clone(preset.settings);
    this.persist();
    this.build();
    return true;
  }
  modelFiles(profile) {
    const advanced = details("Model files");
    this.modelFilesDetails = advanced.root;
    advanced.root.open = Boolean(this.modelFilesExpanded);
    const source = modelSource(profile);
    const architectures = this.data?.profiles;
    const architecture = select(
      "Architecture",
      architectures?.map((candidate) => ({ value: candidate.id, label: candidate.label })) ?? [
        { value: this.value.profile_id, label: "Loading architectures…" },
      ],
      this.value.profile_id,
    );
    architecture.control.disabled = !this.data;
    architecture.control.addEventListener("change", () => {
      this.changeProfile(architecture.control.value);
      architecture.control.value = this.value.profile_id;
    });
    advanced.body.append(architecture.field);
    const externalModels = ["model", "clip", "vae"].every((name) =>
      this.linked(name),
    );
    if (externalModels)
      advanced.body.append(
        el("p", "dmai-muted", "Using connected model, CLIP and VAE."),
      );
    else if (profile) {
      for (const f of profile.model_fields) {
        if (f.key === source?.key) continue;
        const list = this.data.models[f.inventory] ?? [],
          picker = select(
            f.label,
            [
              { value: "", label: "Choose an installed file" },
              ...list.map((name) => ({ value: name, label: name })),
            ],
            inventoryName(list, this.value.models[f.key]) ?? this.value.models[f.key],
          );
        picker.control.addEventListener("change", () => {
          if (!this.changeModelFile(f.key, picker.control.value))
            picker.control.value = inventoryName(list, this.value.models[f.key]) ?? this.value.models[f.key];
        });
        advanced.body.append(picker.field);
      }
      const missing = profile.model_fields.filter(
        (f) =>
          f.required &&
          inventoryName(this.data.models[f.inventory], this.value.models[f.key]) === undefined,
      );
      if (missing.length) {
        advanced.root.open = true;
        advanced.body.append(
          el(
            "p",
            "dmai-warning",
            `Choose installed files: ${missing.map((f) => f.label).join(", ")}.`,
          ),
        );
      }
      if (["model", "clip", "vae"].some((name) => this.linked(name)))
        advanced.body.append(
          el(
            "p",
            "dmai-warning",
            "Connect model, CLIP and VAE together to use external models.",
          ),
        );
    }
    advanced.body.append(
      button(
        "Refresh model list",
        "swap",
        () =>
          this.guard(async () => {
            if (!this.commitControls()) return;
            this.data = await this.context.bootstrap(true);
            this.build();
          }),
        true,
      ),
    );
    if (profile?.default_guidance !== undefined && !this.linked("positive"))
      advanced.body.append(
        el(
          "p",
          "dmai-muted",
          `Model guidance: ${profile.default_guidance}. Connect conditioning for custom guidance.`,
        ),
      );
    this.body.append(advanced.root);
  }
  manual(settings, profile) {
    const grid = el("div", "dmai-settings");
    const controls = {}, fields = {};
    for (const [name, label, type, min, max, step] of [
      ["steps", "Steps", "number", 1, 150, 1],
      ["cfg", "CFG", "number", 0, 30, 0.1],
      ["denoise", "Denoise", "number", 0, 1, 0.05],
    ]) {
      const f = input(label, type, settings[name]);
      Object.assign(f.control, { min, max, step });
      f.field.hidden = this.linked("sigmas") && name !== "cfg";
      controls[name] = f.control;
      fields[name] = f.field;
    }
    for (const [name, label, items] of [
      ["sampler", "Sampler", this.data?.samplers ?? [settings.sampler]],
      ["scheduler", "Scheduler", this.data?.schedulers ?? [settings.scheduler]],
      [
        "enhancer",
        "Enhancer",
        profile?.family === "krea2" ? ["none", "krea2t"] : ["none"],
      ],
    ]) {
      const f = select(label, items, settings[name]);
      if (name === "sampler" || name === "enhancer")
        f.field.classList.add("dmai-field-wide");
      f.field.hidden =
        (name === "sampler" && this.linked("sampler")) ||
        (name === "scheduler" && this.linked("sigmas")) ||
        (name === "enhancer" && profile?.family !== "krea2");
      controls[name] = f.control;
      fields[name] = f.field;
    }
    grid.append(...["steps", "cfg", "sampler", "scheduler", "denoise", "enhancer"].map((name) => fields[name]));
    this.commitManual = () => {
      try {
        const next = validateSettings({
          steps: Number(controls.steps.value || NaN),
          cfg: controls.cfg.value === "" ? NaN : Number(controls.cfg.value),
          denoise:
            controls.denoise.value === ""
              ? NaN
              : Number(controls.denoise.value),
          sampler: controls.sampler.value,
          scheduler: controls.scheduler.value,
          enhancer: controls.enhancer.value,
        });
        this.value.settings = next;
        this.manualDrafts()[this.value.profile_id] = clone(next);
        this.persist();
        return true;
      } catch (error) {
        this.error(error);
        return false;
      }
    };
    for (const c of Object.values(controls))
      c.addEventListener("change", () => {
        if (this.commitManual()) this.note();
      });
    this.body.append(grid);
  }
  async importFile(file) {
    if (this.value.mode !== "enhanced")
      throw new Error("Switch to DMAI Enhanced to upload JSON settings.");
    if (!this.commitControls()) return;
    const profileId = this.value.profile_id;
    if (file.size > 128 * 1024)
      throw new Error("Preset files must be 128 KiB or smaller.");
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      throw new Error("Preset file must contain valid JSON.");
    }
    const result = await envelope(this.context.api, "/presets/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (this.disposed || !this.commitControls()) return;
    if (this.value.mode !== "enhanced" || this.value.profile_id !== profileId)
      throw new Error("Engine mode or model changed during upload. Upload the JSON again in DMAI Enhanced.");
    const presets = mergePresets(
      this.value.presets,
      result.presets,
      this.data.presets,
    );
    const first = result.presets.find((preset) => preset.model.id === profileId) ?? result.presets[0];
    this.value.presets = presets;
    if (this.value.profile_id !== first.model.id)
      this.changeProfile(first.model.id);
    if (this.value.mode === "manual")
      this.manualDrafts()[this.value.profile_id] = clone(this.value.settings);
    this.value.mode = "enhanced";
    this.value.preset_id = first.id;
    this.value.settings = clone(first.settings);
    this.persist();
    this.build();
    this.note(
      `${result.presets.length} preset${result.presets.length === 1 ? "" : "s"} imported.`,
    );
  }
  managePresets() {
    if (!this.commitControls()) return;
    const d = this.show("Imported presets");
    const draw = () => {
      d.body.replaceChildren();
      for (const preset of this.value.presets) {
        const row = el("div", "dmai-row");
        row.append(
          el("span", "", preset.name),
          button(`Remove ${preset.name}`, "close", () => {
            const effective = clone(this.effective());
            this.value.presets = this.value.presets.filter(
              (p) => p.id !== preset.id,
            );
            for (const draft of Object.values(this.drafts()))
              if (draft.preset_id === preset.id) {
                draft.mode = "manual";
                draft.preset_id = "";
                draft.settings = clone(preset.settings);
              }
            if (this.value.preset_id === preset.id) {
              this.value.mode = "manual";
              this.value.preset_id = "";
              this.value.settings = effective;
            }
            this.persist();
            this.build();
            if (this.value.presets.length) draw();
            else d.root.close();
          }),
        );
        d.body.append(row);
      }
    };
    draw();
  }
}
