# Validation — 0.1.0 preview

Checked on 2026-09-28. This release has working ComfyUI registration, CPU contract tests and real local API checks. GPU image generation is still pending.

## Reference environment

- Windows, Python 3.12.11, CPU PyTorch 2.14.0.
- ComfyUI v0.37.0, commit `73c9bad4d21e7addbe1d13bc92eee0f1431b017d`.
- The tag's frontend package: 1.52.7.
- A separate loopback-only installation, empty large-model folders and isolated output storage.
- No paid compute, Runpod start or model-weight download.

## Passed

| Check | Evidence |
| --- | --- |
| Python suite | 70 tests passed with optional real-Comfy CPU tests enabled. |
| JavaScript suite | 19 tests passed: dimensions, exact seeds, ordered manifests, strength edits, mode persistence, sampler overrides, ZIP selection, keyboard containment and Comfy change events. |
| Node registration | All seven native V3 nodes appear in real `/object_info`. |
| Runtime choices | Four model profiles, 45 native sampler names and 9 schedulers in the test installation. Extension installations can change these counts. |
| LoRA loading | Four real CPU comparisons use tiny safetensors, Comfy's file loader, ModelPatcher and LoRA weight calculation. Results match the standard loader and expected low-rank math exactly. |
| Model boundaries | Real CPU latent conversions for Wan, FLUX and SDXL; native BasicScheduler/V3 outputs; sampler registry and Krea family checks. |
| Enhancer dependency | Both pinned upstream implementations, 1.1.0 and 1.4.2, pass source/signature checks and register the expected patch on a small test object. No model inference. |
| Gallery | Real Comfy queue jobs save synthetic 64×64 PNGs. Two selected ZIP entries pass CRC and match original download bytes exactly. Unit tests cover history snapshots, cross-gallery rejection and missing originals. |
| UI transport | Native Comfy merges `dmai_gallery` correctly; no second native image-preview payload is emitted. |
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
