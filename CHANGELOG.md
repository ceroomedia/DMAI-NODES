# Changelog

## 0.1.2 — 2026-09-28

- Fixed native socket dragging: DOM panels leave real canvas gutters around input and output hit targets. Hidden JSON widgets no longer affect socket spacing.
- The Engine's top Model selector lists installed files under Checkpoints and Diffusion models. Architecture, text encoders and VAE are in Model files directly underneath.
- Preserve exact filenames, missing selections and architecture-specific settings; refresh missing-file messages when encoder or VAE selections change.

## 0.1.1 — 2026-09-28

- Move Generate from the Generation Engine to the Prompter.
- Add a softly glowing Prompter outline that fills from measured sampling and decoding progress across all requested images.
- Wait for successful workflow completion before showing 100%; errors and cancellation retain their failure state.
- Publish execution-specific progress events through ComfyUI's existing WebSocket, with handlers removed after every run.

## 0.1.0 — 2026-09-28

Initial public DMAI NODES release, using the Slate design.

- Seven ComfyUI V3 nodes with English controls.
- Prompter with 19 ratios, custom dimensions and server-side image count.
- Reorderable LoRA recipes with strict validation, case-preserving file lookup and patch registration reports.
- Krea 2, SDXL, Qwen Image and FLUX.1 Dev adapters, Manual and DMAI Enhanced settings, data-only preset import/export.
- Optional external SAMPLER, SIGMAS, model, latent and conditioning inputs, with RES4LYF integration guidance.
- Standalone Krea-only Enhancer and VAE Encode / Decode nodes.
- Persistent Gallery with per-image downloads, full-history selection snapshots and ZIP exports.
- API workflow examples, local/Portable/Runpod instructions and MIT licensing.

See `docs/VALIDATION.md` for the exact checks and remaining runtime limits.
