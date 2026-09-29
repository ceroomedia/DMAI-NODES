# Validation — 0.1.3 preview

Updated on 2026-09-29. This release has working ComfyUI registration, CPU contract tests and real local API checks. GPU image generation is still pending. The coexistence checks below were added for 0.1.3; earlier Gallery, model-picker and connector observations were made on 2026-09-28.

## 0.1.3 coexistence and migration

- Real ComfyUI loader tests load the new extension alongside legacy V1 and Suite-style V3 Prompter fixtures in both orders. Each ID retains its own schema and execution contract. The new extension does not claim `DMAIPrompter`.
- A running CPU ComfyUI instance loaded the actual older **ComfyUI-DMAI-Suite** and the new package together. `/object_info` contained all seven new nodes and all four Suite nodes. `DMAINodesPrompter` returned `DMAI_PROMPT`; legacy `DMAIPrompter` retained `CONDITIONING, INT, INT, STRING`.
- In the real Canvas frontend, both Prompters appeared in their separate package categories and rendered their own controls. A saved 0.1.2 DMAI NODES workflow upgraded on load with its five links, 1152x768 dimensions, image count 2, model choices and LoRA strengths intact. A legacy Prompter was added, edited, saved and reloaded alongside it; its original ID and widget format were preserved.
- JavaScript regressions cover nested serialized subgraphs, named/positional widget formats, invalid or ambiguous signatures, unchanged settings/links and canonical progress tracking. The new frontend mounts only `DMAINodesPrompter`.
- Eleven Python migration tests cover mixed UI/API graphs, conservative signature checks, invalid links, UTF-8/configuration boundaries, source/output preservation and rejection of legacy nodes before API submission.
- The new LoRA row/name classes are isolated from the matching selectors found in older DMAI frontend styles.

These checks establish registration, UI coexistence and workflow migration. They do not add GPU inference coverage or certify unrelated third-party extension combinations.

## Reference environment

- Windows, Python 3.12.11, CPU PyTorch 2.14.0.
- ComfyUI v0.37.0, commit `73c9bad4d21e7addbe1d13bc92eee0f1431b017d`.
- The tag's frontend package: 1.52.7.
- A separate loopback-only installation, tiny explicitly named QA inventory fixtures, no usable image models and isolated output storage.
- No paid compute, Runpod start or model-weight download.

## Passed

| Check | Evidence |
| --- | --- |
| Python suite | 99 tests passed with optional real-Comfy CPU tests enabled, including registration coexistence, workflow migration, scoped native progress registry updates and multi-image progress. |
| JavaScript suite | 64 tests passed: dimensions, exact seeds, ordered manifests, strength edits, mode persistence, sampler overrides, ZIP selection, keyboard containment, Comfy change events, progress presentation, job lifecycle handling, native socket geometry, model-file selection and safe workflow migration. |
| Node registration | All seven native V3 nodes appear in real `/object_info`. |
| Runtime choices | Four model profiles, 45 native sampler names and 9 schedulers in the test installation. Extension installations can change these counts. |
| LoRA loading | Four real CPU comparisons use tiny safetensors, Comfy's file loader, ModelPatcher and LoRA weight calculation. Results match the standard loader and expected low-rank math exactly. |
| Model boundaries | Real CPU latent conversions for Wan, FLUX and SDXL; native BasicScheduler/V3 outputs; sampler registry and Krea family checks. |
| Enhancer dependency | Both pinned upstream implementations, 1.1.0 and 1.4.2, pass source/signature checks and register the expected patch on a small test object. No model inference. |
| Gallery | Real Comfy queue jobs save synthetic 64×64 PNGs. Two selected ZIP entries pass CRC and match original download bytes exactly. Unit tests cover history snapshots, cross-gallery rejection and missing originals. |
| UI transport | Native Comfy merges `dmai_gallery` correctly; no second native image-preview payload is emitted. |
| Progress transport | A real `/prompt` job and WebSocket emitted `preparing` then `error` with the correct prompt and Engine IDs when the optional enhancer was absent. No completion event was fabricated. |
| Progress lifecycle | Automated tests cover cached jobs, subgraph identity, multiple Engine branches, queued-job removal, failure, cancellation, disconnect and cleanup. Only native workflow success reaches 100%. |
| Progress browser check | Generate appears only in Prompter. A real Comfy execution failure re-enabled it and showed the actionable error. The production component harness displayed a 42% perimeter, disabled Generate while active, and restored it at 100% completion using explicitly labeled fixture states. |
| Native connections | Reproduced the old failure: dragging the visible edge socket panned the canvas. After repair, mouse drags created Prompter→Engine, LoRA→Engine, Engine IMAGE→Gallery and Engine REPORT→Gallery links. Dragging from the advanced SAMPLER input opened Comfy's compatible-node search and connected native KSamplerSelect. All five links survived save and reload. |
| Model picker | Real Comfy inventories supplied one checkpoint, two diffusion files (including a nested path), one encoder and one VAE fixture. The top selector exposed both groups. Switching checkpoint/diffusion source, explicitly choosing Qwen architecture, and saving/reloading preserved the exact file paths and supporting selections. Removing/reselecting a VAE updated the missing-file message immediately without closing Model files. No fixture is a usable generation model. |
| Browser | Production panels render in real Comfy Canvas. Custom dimensions, image count, Manual/Enhanced round trips and native sampler/scheduler menus were exercised. Saving and reloading retained 1152×768, count 2, 22 steps, DPM++ 2M and Karras. Reordering retained LoRA model strength 0.65 and independent CLIP strength 0.4. Comfy's unsaved marker and Undo respond to edits. Two non-adjacent Gallery images could be selected. |

The visual Gallery fixtures are solid-color test images, not generated model results.

## Not yet verified

- Full Krea, SDXL, Qwen or FLUX image inference and visual quality on GPU.
- Original enhancer 1.1.0 versus 1.4.2 image parity.
- Installed RES4LYF sampling and its stochastic or custom scheduling behavior. Integration is checked against upstream interfaces and guarded at the Engine boundary.
- Runpod templates, Linux GPU installations and memory requirements for each model/precision.
- Complete Nodes 2.0 renderer behavior. Native sockets remain available through the renderer's own layout; Canvas is the visual reference.
- Browser download completion: the in-app test browser ran the ZIP button request successfully but did not expose a completed download event. ZIP contents and original files were verified directly over HTTP.
- Every third-party model variant, LoRA or custom-node combination.

Do not interpret a registered patch or a passing tensor fixture as a model-quality guarantee. Start with one image and the recommended model files when validating a new machine.

## Reproduce

Run from a Git checkout of DMAI NODES; the install ZIP does not include tests. Lightweight Python tests need only `requirements.txt`; real-Comfy checks skip by default. JavaScript tests require Node.js 22 or newer:

```bash
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
node --test tests-js/*.test.mjs
python tools/build_release.py
```

For real CPU checks, use an environment with the reference ComfyUI and CPU torch available. Set `DMAI_RUN_COMFY_TESTS=1` and `DMAI_COMFY_SOURCE` to your ComfyUI source directory before running unittest. No weights are required. These checks use explicit CPU configuration.

The release builder includes allowlisted package files and verifies ZIP CRC. The SHA-256 file identifies the exact download. CI is configured to check the lightweight suite on Windows and Ubuntu; optional real-Comfy tests are local evidence, not part of the lightweight CI job.
