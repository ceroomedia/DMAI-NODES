import { readPrompt } from "./core.mjs";

export const PROMPTER_TYPE = "DMAINodesPrompter";
const PREVIEW_PROMPTER_TYPE = "DMAIPrompter";
const CONFIG_KEYS = ["schema_version", "prompt", "negative_prompt", "width", "height", "count"];
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function promptConfig(raw) {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > 128 * 1024) return null;
  try {
    const value = readPrompt(raw);
    if (
      Object.keys(value).length !== CONFIG_KEYS.length ||
      !CONFIG_KEYS.every((key) => Object.hasOwn(value, key)) ||
      value.width * value.height > 16777216 ||
      [value.prompt, value.negative_prompt].some((text) => [...text].length > 65536 || text.includes("\0"))
    ) return null;
    return value;
  } catch { return null; }
}

// The old Suite also owns DMAIPrompter. Its CLIP/conditioning node must never
// be aliased or rewritten: only the complete 0.1.x request signature is ours.
export function isPreviewPrompter(node) {
  if (!isObject(node) || node.type !== PREVIEW_PROMPTER_TYPE) return false;
  if (!Array.isArray(node.outputs) || node.outputs.length !== 1) return false;
  const output = node.outputs[0];
  if (
    output?.name !== "request" || output.type !== "DMAI_PROMPT" ||
    (output.slot_index !== undefined && output.slot_index !== 0)
  ) return false;
  const inputs = node.inputs ?? [];
  if (!Array.isArray(inputs) || inputs.some((input) =>
    !["text", "config_json"].includes(input?.name) || input.type !== "STRING"
  ) || new Set(inputs.map((input) => input.name)).size !== inputs.length) return false;

  const candidates = [];
  if (node.widgets_values !== undefined) {
    if (!Array.isArray(node.widgets_values) || node.widgets_values.length !== 1) return false;
    candidates.push(node.widgets_values[0]);
  }
  if (node.widgets_values_named !== undefined) {
    const named = node.widgets_values_named;
    if (!isObject(named) || Object.keys(named).length !== 1 || !Object.hasOwn(named, "config_json")) return false;
    candidates.push(named.config_json);
  }
  if (!candidates.length) return false;
  const configs = candidates.map(promptConfig);
  if (configs.some((config) => !config)) return false;
  return configs.every((config) => config && CONFIG_KEYS.every((key) => config[key] === configs[0][key]));
}

// ComfyUI's serialized subgraphs live in definitions.subgraphs, including
// nested definitions. Runtime node.subgraph and arbitrary metadata are not
// serialized node collections and must not be rewritten.
export function migratePreviewPrompters(workflow) {
  const pending = [workflow], visited = new Set();
  let migrated = 0;
  while (pending.length) {
    const graph = pending.pop();
    if (!isObject(graph) || visited.has(graph)) continue;
    visited.add(graph);
    if (Array.isArray(graph.nodes)) {
      for (const node of graph.nodes) {
        if (!isPreviewPrompter(node)) continue;
        node.type = PROMPTER_TYPE;
        if (node.properties?.["Node name for S&R"] === PREVIEW_PROMPTER_TYPE)
          node.properties["Node name for S&R"] = PROMPTER_TYPE;
        migrated++;
      }
    }
    const subgraphs = graph.definitions?.subgraphs;
    if (Array.isArray(subgraphs)) pending.push(...subgraphs);
  }
  return migrated;
}
