const PHASES = {
  idle: "",
  queued: "Queued",
  loading: "Loading",
  sampling: "Generating",
  decoding: "Decoding",
  saving: "Saving",
  complete: "Complete",
  error: "Failed",
  interrupted: "Stopped",
};
const ACTIVE = new Set(["queued", "loading", "sampling", "decoding", "saving"]);

export function progressPresentation(state = {}) {
  const phase = Object.hasOwn(PHASES, state.phase) ? state.phase : "idle";
  const busy = ACTIVE.has(phase);
  const measured = typeof state.percent === "number" && Number.isFinite(state.percent)
    ? Math.max(0, Math.min(100, state.percent)) : 0;
  // A full border means the workflow completed, including decode and save.
  const percent = phase === "complete" ? 100 : Math.min(measured, 99.9);
  return {
    phase,
    percent: phase === "idle" ? 0 : percent,
    busy,
    label: PHASES[phase],
    visible: phase !== "idle",
    value: phase === "complete" ? 100 : Math.floor(percent),
  };
}

export function perimeterPath(width, height) {
  const w = Math.max(8, Number.isFinite(width) ? width : 8);
  const h = Math.max(8, Number.isFinite(height) ? height : 8);
  const inset = 2, right = w - inset, bottom = h - inset;
  const r = Math.min(10, (w - 4) / 2, (h - 4) / 2);
  // Start at the top centre and follow the actual, rounded panel clockwise.
  return `M ${w / 2} ${inset} H ${right - r} Q ${right} ${inset} ${right} ${inset + r} V ${bottom - r} Q ${right} ${bottom} ${right - r} ${bottom} H ${inset + r} Q ${inset} ${bottom} ${inset} ${bottom - r} V ${inset + r} Q ${inset} ${inset} ${inset + r} ${inset} H ${w / 2}`;
}

export class ProgressView {
  constructor(panel) {
    this.panel = panel;
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.classList.add("dmai-progress-outline");
    this.svg.setAttribute("aria-hidden", "true");
    this.svg.setAttribute("focusable", "false");
    this.track = document.createElementNS(this.svg.namespaceURI, "path");
    this.track.classList.add("dmai-progress-track");
    this.stroke = document.createElementNS(this.svg.namespaceURI, "path");
    this.stroke.classList.add("dmai-progress-stroke");
    this.stroke.setAttribute("pathLength", "100");
    this.stroke.setAttribute("stroke-dasharray", "100");
    this.stroke.setAttribute("stroke-dashoffset", "100");
    this.svg.append(this.track, this.stroke);
    panel.append(this.svg);
    this.readout = document.createElement("div");
    this.readout.className = "dmai-progress-readout";
    this.readout.setAttribute("role", "progressbar");
    this.readout.setAttribute("aria-label", "Image generation progress");
    this.readout.setAttribute("aria-valuemin", "0");
    this.readout.setAttribute("aria-valuemax", "100");
    this.label = document.createElement("span");
    this.value = document.createElement("span");
    this.value.className = "dmai-progress-value";
    this.readout.append(this.label, this.value);
    this.resize = () => {
      const width = panel.clientWidth, height = panel.clientHeight;
      if (!width || !height) return;
      this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      const path = perimeterPath(width, height);
      this.track.setAttribute("d", path);
      this.stroke.setAttribute("d", path);
    };
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(this.resize);
      this.observer.observe(panel);
    }
    this.resize();
    this.update();
  }
  update(state) {
    const view = progressPresentation(state);
    this.panel.dataset.generationPhase = view.phase;
    this.panel.dataset.generating = String(view.busy);
    this.panel.setAttribute("aria-busy", String(view.busy));
    this.svg.style.visibility = view.visible ? "visible" : "hidden";
    this.stroke.style.strokeDashoffset = String(100 - view.percent);
    this.readout.hidden = !view.visible;
    this.readout.setAttribute("aria-valuenow", String(view.value));
    this.readout.setAttribute("aria-valuetext", `${view.label}, ${view.value}%`);
    this.label.textContent = view.label;
    this.value.textContent = `${view.value}%`;
    return view;
  }
  dispose() {
    this.observer?.disconnect();
    this.svg.remove();
    this.readout.remove();
  }
}
