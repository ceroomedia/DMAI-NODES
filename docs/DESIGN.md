# Interface design — 0.2.0

The interface uses Slate charcoal, a lime action color and locally bundled Inter. All controls are in English. It follows the hierarchy and alignment principles in Apple's [Layout](https://developer.apple.com/design/human-interface-guidelines/layout) and [Typography](https://developer.apple.com/design/human-interface-guidelines/typography) guidance, with its own colors and components.

## Working sizes

- Body: 15 px. Prompt text: 16 px. Node headings: 21 px bold. Secondary labels: 13 px.
- Form controls: at least 44 px high. Generate: 52 px high.
- Panel padding: 22 px. Related controls use consistent 8–16 px gaps.
- Lime identifies the primary action, selected formats and active connections. Text and shape also communicate state.
- Reduced-motion preferences disable decorative animation; numeric progress remains available.

ComfyUI scales every node with the canvas. Around 70–100% zoom is a useful working range; fitting a large graph can make every extension's controls smaller. Minimum dimensions prevent the saved narrow layouts from squeezing the new controls. Larger user-chosen dimensions remain available.

## Structure

**Prompter:** description first, then visual aspect ratios, resolution, image count and Generate. Negative prompt is a disclosure. Real execution progress follows the perimeter.

**LoRA Loader:** the first row identifies a file, its position and enabled state. The second row holds independent Model and CLIP strengths plus ordering arrows. Names wrap rather than collapsing into a tiny column. The list scrolls when needed.

**Generation Engine:** the installed-file selector stays first. Supporting model files are under a disclosure. Manual exposes sampling controls directly. DMAI Enhanced is the only place to upload JSON settings. The old preset catalog is retained internally for saved workflows.

**Gallery:** images take the available space. Selection and ZIP stay in a visible footer while the grid scrolls. Each image retains its preview and download buttons.

**Connections:** Canvas captions sit just above the wire next to the real native socket. There is no second connector toolbar. Leave roughly 200 px between node edges when both sides have captions. Serialized input names, types and link behavior remain unchanged. Nodes 2.0 uses its own renderer and is not the visual reference for this release.
