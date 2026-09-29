# Changelog

## 0.2.0 - 2026-09-29

- Refresh the Slate interface with larger Inter text, roomier controls, a larger prompt field and clearer section spacing.
- Use two-row LoRA cards with full filenames, visible order, enable/edit actions and independently editable Model and CLIP strengths. Keep drag, arrow and keyboard reordering.
- Add readable captions outside the native Canvas socket dots and enforce minimum node dimensions so controls and ports remain usable.
- Start new Engines and all starter workflows in Manual, with enhancement disabled. Keep saved workflow settings and existing model adapters.
- Show JSON upload only in DMAI Enhanced. New preset choices come from imported settings; historical built-in presets remain resolvable for saved workflows. Remove preset export from the interface.
- Preserve manual drafts when switching modes. An Enhanced Engine without a selected preset asks for a DMAI JSON upload or a switch back to Manual.
- Keep the conflict-free `DMAINodesPrompter` ID and legacy workflow migration introduced in 0.1.3.

## 0.1.3 — 2026-09-29

- Give the new Prompter the unique internal ID `DMAINodesPrompter`, keeping its visible name **DMAI Prompter**. Older DMAI Suite and standalone Prompter installations can keep their original node and frontend hooks.
- Upgrade identifiable DMAI NODES 0.1.0-0.1.2 UI workflows before loading; preserve legacy Prompters, node IDs, links and settings.
- Update starter workflows and progress tracking. Add an offline workflow migration tool and migration in the API submission helper, preserving source files.
- Isolate the new LoRA row and filename CSS classes from the older DMAI LoRA Loader styles.

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
