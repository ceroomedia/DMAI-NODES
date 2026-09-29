import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { envelope } from "./core.mjs?v=0.2.0";
import { Prompter, LoRAStack } from "./inputs.mjs?v=0.2.0";
import { Engine } from "./engine.mjs?v=0.2.0";
import { Gallery } from "./gallery.mjs?v=0.2.0";
import { GenerationProgress } from "./progress.mjs?v=0.2.0";
import { PROMPTER_TYPE, migratePreviewPrompters } from "./workflow-migration.mjs?v=0.2.0";

const controllers = new WeakMap();
const types = {
  [PROMPTER_TYPE]: Prompter,
  DMAILoRAStack: LoRAStack,
  DMAIGenerationEngine: Engine,
  DMAIGallery: Gallery,
};
let bootstrapPromise;
const progress = new GenerationProgress({
  api,
  getRootGraph: () => app.rootGraph ?? app.graph,
});
function* graphNodes(graph, visited = new Set()) {
  if (!graph || visited.has(graph)) return;
  visited.add(graph);
  for (const node of graph._nodes ?? []) {
    yield node;
    if (node.subgraph) yield* graphNodes(node.subgraph, visited);
  }
}
const context = {
  api,
  isConfiguring: () => Boolean(app.configuringGraph),
  beforeChange: () => app.canvas?.emitBeforeChange?.(),
  afterChange: () => app.canvas?.emitAfterChange?.(),
  watchProgress: (node, callback) => progress.watch(node, callback),
  generate: (node) => progress.generate(node, async () => {
    for (const current of graphNodes(app.rootGraph ?? app.graph)) {
      const controller = controllers.get(current);
      if (controller instanceof Engine && !controller.disposed && !controller.commitControls())
        throw new Error("Check the Generation Engine settings before generating.");
    }
    return app.queuePrompt(0, 1);
  }),
  bootstrap(refresh = false) {
    if (refresh || !bootstrapPromise)
      bootstrapPromise = envelope(api, "/bootstrap").catch((error) => {
        bootstrapPromise = null;
        throw error;
      });
    return bootstrapPromise;
  },
};
function install(node) {
  const Class = types[node.comfyClass ?? node.type];
  if (
    !Class ||
    controllers.has(node) ||
    typeof node.addDOMWidget !== "function"
  )
    return;
  try {
    controllers.set(node, new Class(node, context));
  } catch (error) {
    console.error("DMAI NODES could not initialize", error);
  }
}
function refreshGraph() {
  for (const node of graphNodes(app.rootGraph ?? app.graph)) {
    install(node);
    controllers.get(node)?.hydrate();
  }
}
app.registerExtension({
  name: "DMAI.Nodes.Slate",
  setup() {
    progress.start();
    const href = new URL("./nodes.css?v=0.2.0", import.meta.url).href;
    if (!document.querySelector("link[data-dmai-nodes]")) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.dataset.dmaiNodes = "";
      document.head.append(link);
    }
  },
  nodeCreated: install,
  loadedGraphNode: install,
  beforeConfigureGraph: migratePreviewPrompters,
  afterConfigureGraph: refreshGraph,
  // Every visible socket is the real Comfy socket. No duplicate connection UI.
});
