import { icon } from "./icons.mjs";

// Comfy's DOM wrapper receives pointer events across its whole rectangle. A
// real widget margin leaves canvas space for native socket hit targets; CSS
// padding on the panel alone would still leave the wrapper over the sockets.
export const SOCKET_GUTTER = 22;
export const SOCKET_INSET = 12;

export function layoutNativeSockets(node) {
  const width = node.size?.[0] ?? 360;
  const height = node.size?.[1] ?? 400;
  for (const [slots, x] of [
    [node.inputs ?? [], SOCKET_INSET],
    [node.outputs ?? [], width - SOCKET_INSET],
  ]) {
    // Widget-backed inputs keep Comfy's own conversion, visibility and layout.
    // In particular, our hidden JSON widgets must not consume a socket row.
    const sockets = slots.filter((slot) => !slot.widget);
    const top = 75;
    const bottom = Math.max(top, height - 40);
    sockets.forEach((slot, index) => {
      const y = Math.round(
        sockets.length === 1
          ? (top + bottom) / 2
          : top + ((bottom - top) * index) / (sockets.length - 1),
      );
      if (slot.pos?.[0] !== x || slot.pos?.[1] !== y) slot.pos = [x, y];
    });
  }
}

export const el = (tag, className = "", text) => {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
};
export function containKeyboardEvents(root) {
  // Keep Enter/Delete/Space and editing shortcuts inside our controls. Do not
  // cancel their native behavior: buttons, text editing, Tab and dialog Escape
  // still work, and descendant handlers (such as LoRA reorder) run first.
  const stop = (event) => event.stopPropagation();
  root.addEventListener("keydown", stop);
  root.addEventListener("keyup", stop);
}
export function button(label, name, action, visible = false) {
  const b = el("button", visible ? "dmai-button" : "dmai-icon");
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  if (name) b.innerHTML = icon(name);
  if (visible) b.append(document.createTextNode(label));
  if (action) b.addEventListener("click", action);
  return b;
}
export function input(label, type = "text", value = "") {
  const field = el("label", "dmai-field"),
    caption = el("span", "", label),
    control = el("input");
  control.type = type;
  control.value = value;
  control.setAttribute("aria-label", label);
  field.append(caption, control);
  return { field, control };
}
export function select(label, items, value) {
  const field = el("label", "dmai-field"),
    caption = el("span", "", label),
    control = el("select");
  control.setAttribute("aria-label", label);
  options(control, items, value);
  field.append(caption, control);
  return { field, control };
}
export function options(control, items, value) {
  control.replaceChildren(
    ...items.map((i) => new Option(i.label ?? i, i.value ?? i)),
  );
  if (
    value !== undefined &&
    !items.some((i) => (i.value ?? i) === value) &&
    value !== ""
  )
    control.append(new Option(`${value} · unavailable`, value));
  control.value = value ?? "";
}
export function details(label = "Advanced") {
  const root = el("details", "dmai-details");
  root.append(el("summary", "", label));
  const body = el("div", "dmai-details-body");
  root.append(body);
  return { root, body };
}
export function dialog(title) {
  const root = el("dialog", "dmai-nodes dmai-dialog"),
    head = el("header", "dmai-dialog-head"),
    heading = el("h2", "", title),
    body = el("div", "dmai-dialog-body");
  containKeyboardEvents(root);
  root.setAttribute("aria-label", title);
  head.append(
    heading,
    button("Close dialog", "close", () => root.close()),
  );
  root.append(head, body);
  document.body.append(root);
  const opener = document.activeElement;
  root.addEventListener(
    "close",
    () => {
      root.remove();
      if (opener?.isConnected) opener.focus();
    },
    { once: true },
  );
  root.showModal();
  return { root, body };
}
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob),
    link = el("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function statusMessage(root, message, isError = false) {
  root.textContent = message ?? "";
  root.dataset.error = String(isError);
  root.hidden = !message;
}

export class Controller {
  constructor(node, widgetName, title, iconName, context) {
    this.node = node;
    this.context = context;
    this.disposed = false;
    this.dialogs = new Set();
    this.native = node.widgets?.find((w) => w.name === widgetName);
    if (!this.native)
      throw new Error(`Required widget ${widgetName} is missing.`);
    this.root = el("section", "dmai-nodes dmai-panel");
    containKeyboardEvents(this.root);
    this.root.setAttribute("aria-label", title);
    this.header = el("header", "dmai-head");
    const glyph = el("span", "dmai-glyph");
    glyph.innerHTML = icon(iconName);
    this.header.append(
      glyph,
      el("h2", "", title),
      el("span", "dmai-brand", "DMAI"),
    );
    this.body = el("div", "dmai-body");
    this.status = el("div", "dmai-status");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.status.hidden = true;
    this.root.append(this.header, this.body, this.status);
    // The native value remains the source of serialization and API execution.
    this.native.hidden = true;
    this.native.computeSize = () => [0, -4];
    if (this.native.element) this.native.element.hidden = true;
    // Supported LiteGraph per-node layout and per-slot positions. Vue Nodes uses
    // its own registered DOM socket positions; it retains its native fallback.
    node.widgets_start_y = 4;
    this.widget = node.addDOMWidget(
      `dmai_${widgetName}_ui`,
      "dmai-ui",
      this.root,
      {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => (this.minHeight ?? 300) + SOCKET_GUTTER * 2,
        getMaxHeight: () => Infinity,
        getHeight: () => this.height ?? "100%",
        margin: SOCKET_GUTTER,
      },
    );
    this.widget.serialize = false;
    this.wrap("onConfigure", () => queueMicrotask(() => this.hydrate()));
    this.wrap("onDrawBackground", () => this.positionSlots());
    this.wrap("onResize", () => this.positionSlots());
    this.wrap("onRemoved", () => this.dispose());
    const oldRemove = this.widget.onRemove?.bind(this.widget);
    this.widget.onRemove = (...args) => {
      try {
        return oldRemove?.(...args);
      } finally {
        this.dispose();
      }
    };
    const callback = this.native.callback?.bind(this.native);
    this.native.callback = (...args) => {
      const result = callback?.(...args);
      if (!this.writing) queueMicrotask(() => this.hydrate());
      return result;
    };
  }
  wrap(name, after) {
    const old = this.node[name]?.bind(this.node);
    this.node[name] = (...args) => {
      const result = old?.(...args);
      after(...args);
      return result;
    };
  }
  size(width, height) {
    this.minHeight = height;
    this.node.setSize?.([
      Math.max(width + SOCKET_GUTTER * 2, this.node.size?.[0] ?? 0),
      Math.max(height + SOCKET_GUTTER * 2 + 4, this.node.size?.[1] ?? 0),
    ]);
    this.positionSlots();
  }
  positionSlots() {
    layoutNativeSockets(this.node);
  }
  set(value) {
    const serialized =
      typeof value === "string" ? value : JSON.stringify(value);
    if (this.native.value === serialized) return;
    const graph = this.node.graph;
    const trackChange = graph && !this.context.isConfiguring?.();
    if (trackChange) {
      graph.beforeChange?.(this.node);
      // Current Comfy history listens to canvas change events. The graph
      // callbacks alone only notify optional integrations and redraw the graph.
      this.context.beforeChange?.();
    }
    this.writing = true;
    try {
      this.native.value = serialized;
      this.native.callback?.(this.native.value);
    } finally {
      this.writing = false;
      if (trackChange) {
        graph.afterChange?.(this.node);
        this.context.afterChange?.();
        graph.change?.();
      }
      graph?.setDirtyCanvas?.(true, true);
    }
  }
  error(error) {
    statusMessage(this.status, error?.message ?? String(error), true);
  }
  note(message = "") {
    statusMessage(this.status, message);
  }
  async guard(fn) {
    try {
      return await fn();
    } catch (error) {
      if (!this.disposed) this.error(error);
    }
  }
  show(title) {
    const d = dialog(title);
    this.dialogs.add(d.root);
    d.root.addEventListener("close", () => this.dialogs.delete(d.root), {
      once: true,
    });
    return d;
  }
  invalid(error) {
    this.body.replaceChildren();
    this.error(error);
    const area = el("textarea", "dmai-raw");
    area.value = String(this.native.value ?? "");
    area.setAttribute("aria-label", "Saved JSON configuration");
    const apply = button(
      "Apply corrected JSON",
      "check",
      () => {
        this.set(area.value);
        this.hydrate();
      },
      true,
    );
    this.body.append(area, apply);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.dialogs.forEach((d) => d.close());
    this.dialogs.clear();
  }
}
