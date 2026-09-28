import {
  Controller,
  el,
  button,
  input,
  select,
  details,
  options,
  saveBlob,
  statusMessage,
} from "./dom.mjs";
import {
  readEngine,
  validateSettings,
  clone,
  mergePresets,
  envelope,
  uid,
} from "./core.mjs";

export class Engine extends Controller {
  constructor(node, context) {
    super(node, "config_json", "Generation Engine", "bolt", context);
    this.size(365, 480);
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
        this.presets().find((p) => p.model.id === this.value.profile_id);
      if (!preset) {
        this.error(new Error("Import a preset for this profile first."));
        return;
      }
      this.value.preset_id = preset.id;
      this.value.settings = clone(preset.settings);
    } else
      this.value.settings = clone(
        this.manualDrafts()[this.value.profile_id] ?? this.effective(),
      );
    this.value.mode = mode;
    this.persist();
    this.build();
  }
  changeProfile(id) {
    if (!this.commitControls()) return;
    this.remember();
    if (this.value.mode === "manual")
      this.manualDrafts()[this.value.profile_id] = clone(this.value.settings);
    const profile = this.data.profiles.find((p) => p.id === id);
    if (!profile) return;
    const saved = this.drafts()[id],
      preset = this.presets().find((p) => p.model.id === id),
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
            mode: preset ? "enhanced" : "manual",
            preset_id: preset?.id ?? "",
            settings: clone(preset?.settings ?? profile.default_settings),
            models,
          },
    );
    this.persist();
    this.build();
  }
  build() {
    this.body.replaceChildren();
    this.commitManual = null;
    this.commitSeed = null;
    const profile = this.profile(),
      s = this.effective();
    const profileSelect = select(
      "Model",
      this.data?.profiles?.map((p) => ({ value: p.id, label: p.label })) ?? [
        { value: this.value.profile_id, label: "Loading model profiles…" },
      ],
      this.value.profile_id,
    );
    profileSelect.field.classList.add("dmai-model");
    profileSelect.control.disabled = !this.data;
    profileSelect.control.addEventListener("change", () => {
      this.changeProfile(profileSelect.control.value);
      profileSelect.control.value = this.value.profile_id;
    });
    this.body.append(profileSelect.field);
    const mode = el("div", "dmai-segmented dmai-mode");
    for (const [value, label, glyph] of [
      ["enhanced", "DMAI Enhanced", "spark"],
      ["manual", "Manual", "sliders"],
    ]) {
      const b = button(label, glyph, () => this.applyMode(value), true);
      b.setAttribute("aria-pressed", String(this.value.mode === value));
      b.disabled = !this.data;
      mode.append(b);
    }
    this.body.append(mode);
    const presetRow = el("div", "dmai-preset-row"),
      presetSelect = select(
        "Preset",
        [
          {
            value: "",
            label:
              this.value.mode === "manual"
                ? "Custom settings"
                : "Choose a preset",
          },
          ...this.presets()
            .filter((p) => p.model.id === this.value.profile_id)
            .map((p) => ({ value: p.id, label: p.name })),
        ],
        this.value.mode === "enhanced" ? this.value.preset_id : "",
      );
    presetSelect.control.disabled = !this.data;
    presetSelect.control.addEventListener("change", () => {
      const p = this.presets().find((p) => p.id === presetSelect.control.value);
      if (!p) return;
      if (!this.commitControls()) {
        presetSelect.control.value =
          this.value.mode === "enhanced" ? this.value.preset_id : "";
        return;
      }
      if (this.value.mode === "manual")
        this.manualDrafts()[this.value.profile_id] = clone(this.value.settings);
      this.value.mode = "enhanced";
      this.value.preset_id = p.id;
      this.value.settings = clone(p.settings);
      this.persist();
      this.build();
    });
    const file = el("input");
    file.type = "file";
    file.accept = ".json,application/json";
    file.hidden = true;
    file.addEventListener("change", () =>
      this.guard(async () => {
        const f = file.files?.[0];
        if (f) await this.importFile(f);
        file.value = "";
      }),
    );
    const importButton = button("Import preset JSON", "upload", () =>
        file.click(),
      ),
      exportButton = button("Export preset JSON", "download", () =>
        this.exportPreset(),
      );
    importButton.disabled = !this.data;
    exportButton.disabled = !profile;
    presetRow.append(presetSelect.field, importButton, exportButton, file);
    this.body.append(presetRow);
    const meta = el("div", "dmai-row dmai-preset-meta"),
      origin =
        this.value.mode === "manual"
          ? "Manual"
          : this.value.presets.some((p) => p.id === this.value.preset_id)
            ? "Imported"
            : "DMAI";
    meta.append(
      el("span", "dmai-badge", origin),
      el(
        "span",
        "dmai-muted",
        `${this.linked("sigmas") ? "External sigmas" : `${s.steps} steps`} · CFG ${s.cfg}`,
      ),
    );
    this.body.append(meta);
    if (this.value.mode === "manual") this.manual(s, profile);
    else
      this.body.append(
        el(
          "div",
          "dmai-engine-summary",
          `${this.samplingSummary(s)}${s.enhancer === "krea2t" ? " · Enhancer" : ""}`,
        ),
      );
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
    const advanced = details("Model files");
    const externalModels = ["model", "clip", "vae"].every((name) =>
      this.linked(name),
    );
    if (externalModels)
      advanced.body.append(
        el("p", "dmai-muted", "Using connected model, CLIP and VAE."),
      );
    else if (profile) {
      for (const f of profile.model_fields) {
        const list = this.data.models[f.inventory] ?? [],
          picker = select(
            f.label,
            [
              { value: "", label: "Choose an installed file" },
              ...list.map((name) => ({ value: name, label: name })),
            ],
            this.value.models[f.key],
          );
        picker.control.addEventListener("change", () => {
          this.value.models[f.key] = picker.control.value;
          this.persist();
        });
        advanced.body.append(picker.field);
      }
      const missing = profile.model_fields.filter(
        (f) =>
          f.required &&
          !(this.data.models[f.inventory] ?? []).includes(
            this.value.models[f.key],
          ),
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
    if (this.value.presets.length)
      advanced.body.append(
        button(
          "Manage imported presets",
          "layers",
          () => this.managePresets(),
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
    this.runButton = button(
      "Generate",
      "play",
      () =>
        this.guard(async () => {
          if (!this.commitControls()) return;
          this.runButton.disabled = true;
          try {
            await this.context.queue();
            this.note("Workflow queued.");
          } finally {
            if (!this.disposed) this.runButton.disabled = false;
          }
        }),
      true,
    );
    this.runButton.classList.add("dmai-primary", "dmai-generate");
    this.runButton.disabled = !profile;
    this.body.append(this.runButton);
    if (this.data && !profile)
      this.error(
        new Error(
          "This model profile is not installed. Choose a supported profile.",
        ),
      );
  }
  manual(settings, profile) {
    const grid = el("div", "dmai-settings");
    const controls = {};
    for (const [name, label, type, min, max, step] of [
      ["steps", "Steps", "number", 1, 150, 1],
      ["cfg", "CFG", "number", 0, 30, 0.1],
      ["denoise", "Denoise", "number", 0, 1, 0.05],
    ]) {
      const f = input(label, type, settings[name]);
      Object.assign(f.control, { min, max, step });
      f.field.hidden = this.linked("sigmas") && name !== "cfg";
      controls[name] = f.control;
      grid.append(f.field);
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
      f.field.hidden =
        (name === "sampler" && this.linked("sampler")) ||
        (name === "scheduler" && this.linked("sigmas"));
      controls[name] = f.control;
      grid.append(f.field);
    }
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
    if (!this.commitControls()) return;
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
    const presets = mergePresets(
      this.value.presets,
      result.presets,
      this.data.presets,
    );
    const first = result.presets[0];
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
  exportPreset() {
    if (!this.commitControls()) return;
    const d = this.show("Export preset"),
      name = input("Preset name", "text", "My settings"),
      message = el("p", "dmai-status"),
      save = button(
        "Download JSON",
        "download",
        () =>
          this.guard(async () => {
            try {
              const p = this.profile(),
                payload = {
                  schema_version: 1,
                  id: `custom-${uid()}`,
                  name: name.control.value,
                  model: { id: p.id, label: p.label, family: p.family },
                  settings: clone(this.effective()),
                };
              const result = await envelope(
                this.context.api,
                "/presets/validate",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(payload),
                },
              );
              saveBlob(
                new Blob([JSON.stringify(result.presets[0], null, 2) + "\n"], {
                  type: "application/json",
                }),
                `${payload.id}.json`,
              );
              d.root.close();
            } catch (error) {
              statusMessage(message, error.message, true);
            }
          }),
        true,
      );
    save.classList.add("dmai-primary");
    d.body.append(name.field, message, save);
  }
}
