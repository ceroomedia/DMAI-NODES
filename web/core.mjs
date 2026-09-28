export const API = "/dmai-nodes/v1";
export const RATIOS = [
  "1:1",
  "4:5",
  "5:4",
  "3:4",
  "4:3",
  "2:3",
  "3:2",
  "9:16",
  "16:9",
  "9:21",
  "21:9",
  "9:19.5",
  "19.5:9",
  "10:16",
  "16:10",
  "1:2",
  "2:1",
  "1:3",
  "3:1",
];
export const clone = (value) => structuredClone(value);
export const uid = () => crypto.randomUUID();
export function number(value, min, max, label, integer = false) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  )
    throw new Error(
      `${label} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}.`,
    );
  return value;
}
export function parseObject(raw, label) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      `${label} contains invalid JSON. Your saved value has been preserved.`,
    );
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema_version !== 1
  )
    throw new Error(
      `${label} must be a version 1 object. Your saved value has been preserved.`,
    );
  return value;
}
export function readPrompt(raw) {
  const value = parseObject(raw, "Prompt configuration");
  if (
    typeof value.prompt !== "string" ||
    typeof value.negative_prompt !== "string"
  )
    throw new Error("Prompt and negative prompt must be text.");
  number(value.width, 64, 8192, "Width", true);
  number(value.height, 64, 8192, "Height", true);
  number(value.count, 1, 8, "Image count", true);
  if (value.width % 64 || value.height % 64)
    throw new Error("Dimensions must be multiples of 64.");
  return value;
}
export function dimensions(ratio, resolution) {
  if (!RATIOS.includes(ratio) || !["1K", "2K"].includes(resolution))
    throw new Error("Choose a supported ratio and resolution.");
  const [w, h] = ratio.split(":").map(Number),
    long = resolution === "1K" ? 1024 : 2048;
  return w >= h
    ? [long, Math.max(64, Math.round((long * h) / w / 64) * 64)]
    : [Math.max(64, Math.round((long * w) / h / 64) * 64), long];
}
export function customDimensions(width, height) {
  number(width, 64, 8192, "Width", true);
  number(height, 64, 8192, "Height", true);
  return [width, height].map((n) => Math.round(n / 64) * 64);
}
export function readManifest(raw) {
  const value = parseObject(raw, "LoRA configuration");
  if (!Array.isArray(value.entries))
    throw new Error("LoRA entries must be a list.");
  const ids = new Set();
  for (const e of value.entries) {
    if (!e || typeof e.id !== "string" || !e.id || ids.has(e.id))
      throw new Error("Each LoRA needs a unique entry ID.");
    ids.add(e.id);
    if (typeof e.name !== "string" || !e.name || typeof e.enabled !== "boolean")
      throw new Error(
        "Each LoRA needs a filename and a boolean enabled value.",
      );
    number(e.strength_model, -20, 20, "Model strength");
    number(e.strength_clip, -20, 20, "CLIP strength");
  }
  return value;
}
export function moveEntry(entries, id, to) {
  const from = entries.findIndex((e) => e.id === id);
  if (from < 0 || !Number.isInteger(to) || to < 0 || to >= entries.length)
    return entries.slice();
  const next = entries.slice(),
    [entry] = next.splice(from, 1);
  next.splice(to, 0, entry);
  return next;
}
export function readEngine(raw) {
  const value = parseObject(raw, "Engine configuration");
  if (
    typeof value.profile_id !== "string" ||
    !["enhanced", "manual"].includes(value.mode) ||
    typeof value.preset_id !== "string"
  )
    throw new Error("Engine profile, mode or preset is invalid.");
  if (!value.settings || !value.models || !Array.isArray(value.presets))
    throw new Error("Engine settings, models and presets are required.");
  if (typeof value.seed === "string") {
    if (
      !/^\d{1,20}$/.test(value.seed) ||
      BigInt(value.seed) > 18446744073709551615n
    )
      throw new Error("Seed must be an unsigned 64-bit integer.");
  } else number(value.seed, 0, Number.MAX_SAFE_INTEGER, "Seed", true);
  validateSettings(value.settings);
  for (const key of ["diffusion_model", "text_encoder", "vae", "checkpoint"])
    if (typeof value.models[key] !== "string")
      throw new Error(`Model filename ${key} must be text.`);
  return value;
}
export function validateSettings(s) {
  number(s.steps, 1, 150, "Steps", true);
  number(s.cfg, 0, 30, "CFG");
  number(s.denoise, 0, 1, "Denoise");
  if (
    typeof s.sampler !== "string" ||
    !s.sampler ||
    typeof s.scheduler !== "string" ||
    !s.scheduler ||
    !["none", "krea2t"].includes(s.enhancer)
  )
    throw new Error("Sampler, scheduler or enhancer is invalid.");
  return clone(s);
}
export function mergePresets(existing, incoming, builtins) {
  if (existing.length + incoming.length > 20)
    throw new Error(
      "An engine can store at most 20 imported presets. Remove an imported preset first.",
    );
  const ids = new Set([...existing, ...builtins].map((p) => p.id));
  for (const p of incoming) {
    if (ids.has(p.id))
      throw new Error(
        `Preset ID ${p.id} already exists. Use a new ID before importing.`,
      );
    ids.add(p.id);
  }
  return [...existing, ...incoming].map(clone);
}
export function selectionBody(selection, watermark) {
  if (selection.all) {
    if (!Number.isInteger(watermark) || watermark < 0)
      throw new Error("Refresh the gallery before selecting all images.");
    return { all: true, before: watermark };
  }
  const ids = [...selection.ids];
  if (!ids.length) throw new Error("Select at least one image.");
  return { ids };
}
export async function envelope(api, path, options = {}) {
  const response = await api.fetchApi(`${API}${path}`, options);
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      `DMAI NODES returned an invalid response (${response.status}).`,
    );
  }
  if (!response.ok || data?.ok !== true)
    throw new Error(
      data?.error?.message || `Request failed (${response.status}).`,
    );
  return data.data;
}
export async function binary(api, path, options = {}) {
  const response = await api.fetchApi(`${API}${path}`, options);
  if (!response.ok) {
    let message;
    try {
      message = (await response.json())?.error?.message;
    } catch {}
    throw new Error(message || `Download failed (${response.status}).`);
  }
  return response.blob();
}
