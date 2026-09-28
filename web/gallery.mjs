import { Controller, el, button, saveBlob } from "./dom.mjs";
import { API, envelope, binary, selectionBody, uid } from "./core.mjs";

export class Gallery extends Controller {
  constructor(node, context) {
    super(node, "gallery_id", "Gallery", "grid", context);
    this.size(465, 500);
    this.items = [];
    this.total = 0;
    this.watermark = 0;
    this.selection = { all: false, ids: new Set() };
    this.generation = 0;
    this.wrap("onAdded", () => queueMicrotask(() => this.hydrate()));
    this.wrap("onExecuted", (output) => {
      const value = Array.isArray(output?.dmai_gallery)
        ? output.dmai_gallery[0]
        : output?.dmai_gallery;
      if (value?.gallery_id === this.id) {
        if (this.selection.all) this.selection.all = false;
        this.guard(() => this.load(true));
      }
    });
    this.hydrate();
  }
  hydrate() {
    if (this.disposed) return;
    let id = String(this.native.value ?? "");
    const graphNodes = this.node.graph?._nodes ?? [],
      ownIndex = graphNodes.indexOf(this.node),
      duplicate =
        ownIndex >= 0 &&
        graphNodes
          .slice(0, ownIndex)
          .some(
            (n) =>
              (n.comfyClass ?? n.type) === "DMAIGallery" &&
              n.widgets?.some((w) => w.name === "gallery_id" && w.value === id),
          );
    if (!id || id === "main" || duplicate) {
      id = uid();
      this.set(id);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
      this.error(
        new Error(
          "Gallery ID must start with a letter or number and use at most 64 letters, numbers, underscores or hyphens.",
        ),
      );
      return;
    }
    if (this.id !== id) {
      this.id = id;
      this.items = [];
      this.selection = { all: false, ids: new Set() };
    }
    this.build();
    this.guard(() => this.load(true));
  }
  async load(reset = false) {
    const token = ++this.generation,
      id = this.id;
    this.note("Loading images…");
    const offset = reset ? 0 : this.items.length;
    const query = `?offset=${offset}&limit=60${reset ? "" : `&before=${this.watermark}`}`;
    const data = await envelope(
      this.context.api,
      `/galleries/${encodeURIComponent(id)}${query}`,
    );
    if (this.disposed || token !== this.generation || id !== this.id) return;
    if (reset) {
      this.items = data.items;
      this.watermark = data.watermark;
    } else {
      const known = new Set(this.items.map((i) => i.id));
      this.items.push(...data.items.filter((i) => !known.has(i.id)));
    }
    this.total = data.total;
    this.note();
    this.build();
  }
  src(item, thumbnail = false) {
    const canonical = `${API}/images/${encodeURIComponent(item.id)}`;
    const path =
      thumbnail &&
      typeof item.thumbnail_url === "string" &&
      item.thumbnail_url.startsWith(`${API}/images/`)
        ? item.thumbnail_url
        : canonical;
    return this.context.api.apiURL ? this.context.api.apiURL(path) : path;
  }
  build() {
    this.body.replaceChildren();
    const bar = el("div", "dmai-row dmai-gallery-toolbar");
    bar.append(el("span", "dmai-muted", `${this.total} images`));
    const actions = el("div", "dmai-row");
    actions.append(
      button("Refresh gallery", "swap", () =>
        this.guard(() => this.load(true)),
      ),
      button("Select all images", "select", () =>
        this.guard(() => this.selectAll()),
      ),
      button("Change grid density", "grid", () => {
        this.dense = !this.dense;
        this.build();
      }),
    );
    bar.append(actions);
    this.body.append(bar);
    const scroll = el("div", "dmai-gallery-scroll"),
      grid = el("div", `dmai-gallery-grid${this.dense ? " dmai-dense" : ""}`);
    this.items.forEach((item) => {
      const card = el("div", "dmai-image-card"),
        selectButton = button(`Select image ${item.filename}`, null, () =>
          this.toggle(item.id),
        );
      selectButton.classList.add("dmai-image-select");
      selectButton.setAttribute(
        "aria-pressed",
        String(this.selection.ids.has(item.id)),
      );
      const img = el("img");
      img.src = this.src(item, true);
      img.alt = `Generated image ${item.filename}`;
      img.loading = "lazy";
      img.decoding = "async";
      selectButton.append(img);
      const check = el("span", "dmai-check");
      check.textContent = this.selection.ids.has(item.id) ? "✓" : "";
      selectButton.append(check);
      const tools = el("div", "dmai-image-actions");
      tools.append(
        button(`Preview ${item.filename}`, "expand", () => this.preview(item)),
        button(`Download ${item.filename}`, "download", () =>
          this.guard(() => this.download(item)),
        ),
      );
      card.append(selectButton, tools);
      grid.append(card);
    });
    if (!this.items.length)
      scroll.append(
        el(
          "div",
          "dmai-empty dmai-gallery-empty",
          "Your generated images appear here.",
        ),
      );
    scroll.append(grid);
    if (this.items.length < this.total)
      scroll.append(
        button(
          `Load more · ${this.items.length} / ${this.total}`,
          "down",
          () => this.guard(() => this.load()),
          true,
        ),
      );
    this.body.append(scroll);
    const foot = el("footer", "dmai-row dmai-selection"),
      clear = button("Clear selection", "close", () => {
        this.selection = { all: false, ids: new Set() };
        this.build();
      }),
      selected = el("span", "", `${this.selection.ids.size} selected`),
      zip = button("Download selected images as ZIP", "download", () =>
        this.guard(async () => {
          zip.disabled = true;
          try {
            const body = selectionBody(
                this.selection,
                this.selection.watermark ?? this.watermark,
              ),
              count = this.selection.ids.size;
            const blob = await binary(
              this.context.api,
              `/galleries/${encodeURIComponent(this.id)}/zip`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              },
            );
            saveBlob(blob, `DMAI-${count}-images.zip`);
            this.note("ZIP download started.");
          } finally {
            if (!this.disposed) zip.disabled = this.selection.ids.size === 0;
          }
        }),
      );
    zip.append(document.createTextNode("ZIP"));
    zip.classList.add("dmai-primary");
    zip.disabled = this.selection.ids.size === 0;
    foot.append(clear, selected, zip);
    this.body.append(foot);
  }
  toggle(id) {
    if (!this.selection.ids.has(id) && this.selection.ids.size >= 100) {
      this.error(new Error("ZIP supports up to 100 selected images."));
      return;
    }
    this.selection.all = false;
    this.selection.ids.has(id)
      ? this.selection.ids.delete(id)
      : this.selection.ids.add(id);
    this.build();
  }
  async selectAll() {
    if (this.total > 100)
      throw new Error(
        "ZIP supports up to 100 images or 2 GiB. Select up to 100 images individually.",
      );
    if (!this.total) return;
    const watermark = this.watermark,
      id = this.id,
      ids = new Set(this.items.map((i) => i.id));
    let offset = this.items.length;
    while (offset < this.total) {
      const data = await envelope(
        this.context.api,
        `/galleries/${encodeURIComponent(id)}?offset=${offset}&limit=60&before=${watermark}`,
      );
      if (this.id !== id || this.watermark !== watermark)
        throw new Error("The gallery changed. Select all again.");
      if (!data.items.length) break;
      data.items.forEach((i) => ids.add(i.id));
      offset += data.items.length;
    }
    this.selection = { all: true, ids, watermark };
    this.note();
    this.build();
  }
  async download(item) {
    const blob = await binary(
      this.context.api,
      `/images/${encodeURIComponent(item.id)}?download=1`,
    );
    saveBlob(blob, item.filename || `DMAI-${item.id}.png`);
    this.note("Image download started.");
  }
  preview(item) {
    const d = this.show("Image preview"),
      img = el("img", "dmai-lightbox");
    img.src = this.src(item);
    img.alt = item.filename;
    d.body.append(
      img,
      el("p", "dmai-muted", `${item.width} × ${item.height}`),
      button(
        "Download original",
        "download",
        () => this.guard(() => this.download(item)),
        true,
      ),
    );
  }
  dispose() {
    this.generation++;
    super.dispose();
  }
}
