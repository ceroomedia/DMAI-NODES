import test from "node:test";
import assert from "node:assert/strict";
import {
  Controller,
  SOCKET_GUTTER,
  SOCKET_INSET,
  layoutNativeSockets,
} from "../web/dom.mjs";

class Element extends EventTarget {
  append() {}
  setAttribute() {}
}

function controller() {
  const savedDocument = globalThis.document;
  globalThis.document = { createElement: () => new Element() };
  try {
    const node = {
      widgets: [{ name: "config_json", value: "{}" }],
      size: [360, 400],
      inputs: [{ name: "request", type: "DMAI_PROMPT" }],
      outputs: [{ name: "images", type: "IMAGE" }],
      setSize(size) {
        this.size = size;
        this.onResize?.(size);
      },
      addDOMWidget(name, type, root, options) {
        this.domOptions = options;
        return {};
      },
    };
    return new Controller(node, "config_json", "Test", "sparkles", {});
  } finally {
    globalThis.document = savedDocument;
  }
}

test("native socket centres and their 20px hit boxes stay inside the node and outside the DOM wrapper", () => {
  const instance = controller();
  instance.size(360, 400);
  const { node } = instance;
  const margin = node.domOptions.margin;
  assert.equal(margin, SOCKET_GUTTER);
  for (const [side, slots] of [["input", node.inputs], ["output", node.outputs]]) {
    for (const slot of slots) {
      const [x, y] = slot.pos;
      assert.ok(x - 10 >= 0 && x + 10 <= node.size[0]);
      assert.ok(y - 10 > 0 && y + 10 < node.size[1]);
      assert.ok(
        side === "input" ? x + 10 <= margin : x - 10 >= node.size[0] - margin,
        "native pointer target must not be under Comfy's pointer-events:auto DOM wrapper",
      );
    }
  }
});

test("hidden JSON input widgets do not consume connector rows", () => {
  const input = { name: "text", type: "STRING" };
  const config = { name: "config_json", widget: { name: "config_json" }, pos: [10, 14] };
  const node = { size: [404, 448], inputs: [input, config], outputs: [] };
  layoutNativeSockets(node);
  const withConfig = [...input.pos];
  node.inputs.pop();
  layoutNativeSockets(node);
  assert.deepEqual(input.pos, withConfig);
  assert.deepEqual(config.pos, [10, 14], "widget conversion and layout remain native");
});

test("all Engine inputs, including advanced unconnected sockets, remain separate and accessible", () => {
  const names = ["request", "loras", "sampler", "sigmas", "model", "clip", "vae", "latent", "positive", "negative"];
  const node = {
    size: [409, 528],
    inputs: names.map((name, index) => ({ name, advanced: index > 1, link: null })),
    outputs: [{ name: "images" }, { name: "report" }],
  };
  layoutNativeSockets(node);
  assert.equal(new Set(node.inputs.map((slot) => slot.pos[1])).size, names.length);
  for (let i = 0; i < names.length; i++) {
    assert.equal(node.inputs[i].pos[0], SOCKET_INSET);
    if (i) assert.ok(node.inputs[i].pos[1] - node.inputs[i - 1].pos[1] > 20);
  }
  assert.deepEqual(node.inputs.map((slot) => slot.name), names);
});

test("widget-backed converted or connected inputs retain Comfy's own positions and metadata", () => {
  const converted = {
    name: "config_json", type: "STRING", widget: { name: "config_json" },
    link: 12, alwaysVisible: true, pos: [10, 30],
  };
  const original = structuredClone(converted);
  layoutNativeSockets({ size: [404, 448], inputs: [converted], outputs: [] });
  assert.deepEqual(converted, original);
});

test("gutter sizing preserves content dimensions without growing on reload, and resize updates sockets", () => {
  const instance = controller();
  instance.size(360, 400);
  const first = [...instance.node.size];
  assert.equal(first[0] - 2 * SOCKET_GUTTER, 360);
  assert.equal(instance.node.domOptions.getMinHeight() - 2 * SOCKET_GUTTER, 400);
  instance.size(360, 400);
  assert.deepEqual(instance.node.size, first);
  instance.node.setSize([500, 600]);
  assert.equal(instance.node.outputs[0].pos[0], 500 - SOCKET_INSET);
  assert.ok(instance.node.outputs[0].pos[1] > 250);
  instance.size(360, 400);
  assert.deepEqual(instance.node.size, [500, 600], "keep user-expanded nodes");
});
