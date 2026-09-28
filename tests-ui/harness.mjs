// Component QA only. This exercises the exact shipped controller classes with
// fixture transport. It does not establish Comfy rendering or GPU compatibility.
import { Prompter, LoRAStack } from "../web/inputs.mjs";
import { Engine } from "../web/engine.mjs";
import { Gallery } from "../web/gallery.mjs";
const settings = {
  steps: 8,
  cfg: 1.1,
  sampler: "euler",
  scheduler: "beta",
  denoise: 1,
  enhancer: "krea2t",
};
const profile = {
  id: "krea2-turbo",
  label: "Krea 2 Turbo",
  family: "krea2",
  model_fields: [
    {
      key: "diffusion_model",
      inventory: "diffusion_models",
      label: "Diffusion model",
      required: true,
      default: "krea.safetensors",
    },
    {
      key: "text_encoder",
      inventory: "text_encoders",
      label: "Text encoder",
      required: true,
      default: "qwen.safetensors",
    },
    {
      key: "vae",
      inventory: "vae",
      label: "VAE",
      required: true,
      default: "wan.safetensors",
    },
  ],
  default_settings: settings,
  resolution_multiple: 64,
  max_dimension: 8192,
  max_pixels: 16777216,
};
const preset = {
  schema_version: 1,
  id: "dmai-krea2-original-v1",
  name: "Krea / Original",
  model: { id: profile.id, label: profile.label, family: profile.family },
  settings,
};
const data = {
  profiles: [
    profile,
    {
      id: "sdxl-checkpoint",
      label: "SDXL Checkpoint",
      family: "sdxl",
      model_fields: [
        {
          key: "checkpoint",
          inventory: "checkpoints",
          label: "Checkpoint",
          required: true,
          default: "",
        },
      ],
      default_settings: {
        ...settings,
        steps: 20,
        cfg: 7,
        scheduler: "normal",
        enhancer: "none",
      },
      resolution_multiple: 64,
      max_dimension: 8192,
      max_pixels: 16777216,
    },
  ],
  presets: [preset],
  models: {
    diffusion_models: ["krea.safetensors"],
    text_encoders: ["qwen.safetensors"],
    vae: ["wan.safetensors"],
    checkpoints: ["sdxl.safetensors"],
  },
  loras: [
    { id: "catalog-one", name: "style/soft-light.safetensors" },
    { id: "catalog-two", name: "style/tactile.safetensors" },
  ],
  samplers: ["euler", "heun", "dpmpp_2m"],
  schedulers: ["beta", "normal", "karras"],
};
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9X0AAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);
const items = Array.from({ length: 8 }, (_, index) => ({
  id: `fixture-${index + 1}`,
  filename: `fixture-${index + 1}.png`,
  width: 1024,
  height: 1024,
  created_at: "2026-09-28T12:00:00Z",
}));
const svg = (index) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${["#304b40", "#605343", "#364c56", "#6a6248"][index % 4]}"/><stop offset="1" stop-color="#121b16"/></linearGradient></defs><rect width="400" height="500" fill="url(#g)"/><circle cx="200" cy="225" r="110" fill="none" stroke="#c8ee99" stroke-width="3"/><text x="200" y="240" text-anchor="middle" fill="#c8ee99" font-family="sans-serif" font-size="36">${String(index + 1).padStart(2, "0")}</text></svg>`)}`;
const evidence = (message) =>
  (document.querySelector("#evidence").textContent = message);
const context = {
  bootstrap: async () => structuredClone(data),
  queue: async () =>
    evidence("Queue call: one workflow, backend controls image count."),
  api: {
    apiURL: (path) =>
      svg(Math.max(0, Number(path.match(/fixture-(\d+)/)?.[1] ?? 1) - 1)),
    async fetchApi(path, options = {}) {
      if (path.endsWith("/bootstrap")) return Response.json({ ok: true, data });
      if (path.includes("/galleries/")) {
        if (path.endsWith("/zip")) {
          evidence(`ZIP request: ${options.body}`);
          return Response.json(
            {
              ok: false,
              error: {
                message:
                  "Fixture transport does not generate ZIPs. Verify downloads against the real backend.",
              },
            },
            { status: 501 },
          );
        }
        return Response.json({
          ok: true,
          data: {
            items,
            total: items.length,
            gallery_id: "qa-gallery",
            watermark: 8,
          },
        });
      }
      if (path.includes("/images/")) {
        evidence(
          "Fixture PNG download requested. Selection must stay unchanged.",
        );
        return new Response(png, { headers: { "Content-Type": "image/png" } });
      }
      if (path.endsWith("/presets/validate")) {
        const value = JSON.parse(options.body);
        return Response.json({
          ok: true,
          data: { presets: value.presets ?? [value] },
        });
      }
      throw new Error(`Unexpected fixture route ${path}`);
    },
  },
};
const values = {
  prompter: {
    schema_version: 1,
    prompt:
      "A sculptural object made of dark stone and translucent green glass. Soft side light, a quiet studio background.",
    negative_prompt: "",
    width: 832,
    height: 1024,
    count: 4,
  },
  lora: {
    schema_version: 1,
    entries: [
      {
        id: "a",
        name: "style/soft-light.safetensors",
        enabled: true,
        strength_model: 0.8,
        strength_clip: 0.8,
      },
      {
        id: "b",
        name: "style/tactile.safetensors",
        enabled: true,
        strength_model: 1,
        strength_clip: 0.5,
      },
    ],
  },
  engine: {
    schema_version: 1,
    profile_id: "krea2-turbo",
    mode: "enhanced",
    preset_id: preset.id,
    settings,
    seed: 481516,
    models: {
      diffusion_model: "krea.safetensors",
      text_encoder: "qwen.safetensors",
      vae: "wan.safetensors",
      checkpoint: "",
    },
    presets: [],
  },
  gallery: "qa-gallery",
};
const nodes = {},
  controllers = {};
for (const [key, Class, widgetName] of [
  ["prompter", Prompter, "config_json"],
  ["lora", LoRAStack, "manifest_json"],
  ["engine", Engine, "config_json"],
  ["gallery", Gallery, "gallery_id"],
]) {
  const node = {
    properties:
      key === "prompter"
        ? { dmai_format: { ratio: "4:5", resolution: "1K" } }
        : {},
    widgets: [
      {
        name: widgetName,
        value:
          typeof values[key] === "string"
            ? values[key]
            : JSON.stringify(values[key]),
      },
    ],
    graph: { setDirtyCanvas() {} },
    setSize() {},
    addDOMWidget(name, type, root) {
      document.getElementById(key).append(root);
      return {};
    },
  };
  nodes[key] = node;
  controllers[key] = new Class(node, context);
}
document.querySelector("#restore").onclick = () => {
  const saved = Object.fromEntries(
    Object.entries(nodes).map(([key, n]) => [
      key,
      { value: n.widgets[0].value, properties: structuredClone(n.properties) },
    ]),
  );
  for (const [key, n] of Object.entries(nodes)) {
    n.widgets[0].value = saved[key].value;
    n.properties = saved[key].properties;
    n.onConfigure?.();
  }
  evidence(
    `Native widget values preserved:\n${JSON.stringify(saved, null, 2)}`,
  );
};
document.querySelector("#external").onclick = () => {
  nodes.prompter.widgets[0].value = JSON.stringify({
    ...values.prompter,
    width: 1536,
    height: 1024,
    count: 7,
    prompt: "External API prompt",
  });
  nodes.prompter.widgets[0].callback?.();
  evidence("External serialized JSON applied: 1536 × 1024, 7 images.");
};
document.querySelector("#error").onclick = () => {
  nodes.lora.widgets[0].value = "{broken";
  nodes.lora.widgets[0].callback?.();
  evidence(
    "Invalid LoRA JSON preserved; editor should show the exact original value.",
  );
};
