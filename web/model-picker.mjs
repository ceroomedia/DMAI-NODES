// Inventory names remain native ComfyUI names. The category is part of the
// selection because checkpoints and diffusion models can have identical names.
export const MODEL_SOURCES = [
  { key: "checkpoint", inventory: "checkpoints", label: "Checkpoints" },
  { key: "diffusion_model", inventory: "diffusion_models", label: "Diffusion models" },
];

export function modelSource(profile) {
  return MODEL_SOURCES.find((source) =>
    profile?.model_fields?.some((field) => field.key === source.key),
  );
}

export function modelToken(key, name) {
  return JSON.stringify([key, name]);
}

export function parseModelToken(value) {
  const decoded = JSON.parse(value);
  if (
    !Array.isArray(decoded) || decoded.length !== 2 ||
    !MODEL_SOURCES.some((source) => source.key === decoded[0]) ||
    typeof decoded[1] !== "string" || !decoded[1]
  ) throw new Error("Choose an installed checkpoint or diffusion model.");
  return { key: decoded[0], name: decoded[1] };
}

export function modelGroups(inventory = {}) {
  return MODEL_SOURCES.map((source) => ({
    ...source,
    items: (inventory[source.inventory] ?? []).map((name) => ({
      value: modelToken(source.key, name), label: name,
    })),
  }));
}

export function inventoryName(names = [], saved) {
  if (!saved) return undefined;
  const canonical = (name) => name.replaceAll("\\", "/");
  const matches = names.filter((name) => canonical(name) === canonical(saved));
  return matches.length === 1 ? matches[0] : undefined;
}

export function selectedModel(profile, selections, inventory = {}) {
  const source = modelSource(profile);
  const saved = source && selections[source.key];
  if (!saved) return null;
  // Serialized workflows may use '/' while Windows inventories use '\\'.
  // Match separators only, never basename or case, and retain the native name.
  const native = inventoryName(inventory[source.inventory], saved);
  const available = native !== undefined;
  const name = available ? native : saved;
  return { key: source.key, name, value: modelToken(source.key, name), available };
}

export function profileForSource(profiles, key, currentId, remembered = {}) {
  const compatible = profiles.filter((profile) => modelSource(profile)?.key === key);
  return compatible.find((profile) => profile.id === currentId)
    ?? compatible.find((profile) => profile.id === remembered[key])
    ?? compatible[0];
}
