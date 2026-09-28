---
license: mit
language:
  - en
tags:
  - comfyui
  - custom-nodes
  - image-generation
  - lora
  - dmai
---

# DMAI NODES

**A compact image workflow for ComfyUI.** Slate surfaces, clean Inter typography and English controls.

**0.1.0 preview** · [GitHub releases](https://github.com/ceroomedia/DMAI-NODES/releases) · [Hugging Face download mirror](https://huggingface.co/ceroomedia/DMAI-NODES)

Prompter → Generation Engine → Gallery, with an ordered LoRA Loader feeding the engine.

## What is included

| Node | Purpose |
| --- | --- |
| **DMAI Prompter** | Prompt, 19 aspect ratios, 1K / 2K / Custom dimensions, image count and optional connected text. |
| **DMAI LoRA Loader** | Reorderable stack, enabled state, separate model/CLIP strengths and strict file checks. |
| **DMAI Generation Engine** | Model profiles, DMAI Enhanced or Manual sampling, imported settings presets, seed sequence and execution report. |
| **DMAI Gallery** | Persistent PNG originals, multiple selection, per-image download and selection ZIP. |
| **DMAI Krea Enhancer** | A standalone Krea-only model node, using the optional upstream Krea2T Enhancer. |
| **DMAI VAE Encode / Decode** | Standard Comfy VAE operations, usable separately and with the engine's advanced inputs. |

Sampler and scheduler choices come from the running ComfyUI installation. Optional **SAMPLER** and **SIGMAS** connections support custom sampling workflows, including RES4LYF sampler nodes. See [RES4LYF integration](docs/RES4LYF.md) for the correct outputs and current limits.

The simple path loads models inside the engine. Advanced workflows can supply MODEL, CLIP and VAE together, and an encoded LATENT. Krea enhancement is only available for Krea profiles. A settings preset never installs a new model adapter.

## Install

From your ComfyUI directory, using **the same Python environment as ComfyUI**:

```bash
git clone https://github.com/ceroomedia/DMAI-NODES.git custom_nodes/DMAI-NODES
python -m pip install -r custom_nodes/DMAI-NODES/requirements.txt
```

Restart ComfyUI and refresh the browser. Search for **DMAI** in the node library.

- [Windows Portable, local environments and Runpod](docs/INSTALLATION.md)
- [Model files, presets and enhancement](docs/MODELS.md)
- [API workflow and future website integration](docs/API.md)
- [Validation results and limits](docs/VALIDATION.md)

ZIP installation is also supported: extract the release so `ComfyUI/custom_nodes/DMAI-NODES/__init__.py` exists. A Hugging Face mirror includes the package and checksum; this repository contains **code and documentation, no model weights**.

## First workflow

1. Import a starter from `workflows`: Krea, SDXL, Qwen or FLUX. Use the `.json` file for the UI and `.api.json` for API calls.
2. Select installed model files in the Engine. Install any optional enhancement dependency needed by the selected preset.
3. Enter the prompt and image count. Add LoRAs if needed.
4. Choose **Generate**. Preview or download saved results from Gallery.

For Krea without the optional enhancer, choose **Krea / Clean Base** or Manual with Enhancer set to `none`. Models and LoRAs remain subject to their own licenses.

## Behavior that matters

- LoRAs are applied in their displayed order, before the Engine encodes both prompts. Disabled rows and rows with both strengths at zero are skipped; an active nonzero LoRA with zero effective patch matches raises an error. “Loaded” reports registered patches, not a completed image-quality test. See [advanced conditioning](docs/MODELS.md#advanced-connections) when encoding text upstream.
- Image count is handled by the backend. Images use `seed`, `seed + 1`, and so on, modulo 2^64. The report stores the exact seeds as decimal strings.
- Gallery IDs are serialized in workflows. The new package uses separate storage under `output/DMAI-NODES`; existing DMAI Studio history is not deleted or automatically imported.
- ZIP exports are limited to **100 images / 2 GiB**. Full-history selection uses a snapshot so later images are not silently added.
- Invalid saved JSON remains visible for correction. It is not replaced by defaults.
- This is a new package with new node IDs. Existing Studio, Carousel and Krea Edit workflows remain in their original package.

## Compatibility

Built against ComfyUI **v0.37.0**, with the frontend supplied by that tag. Renderer and inference coverage are recorded in [VALIDATION.md](docs/VALIDATION.md). Native connection ports remain available; custom port positioning may differ between Canvas and Nodes 2.0.

No cloud service or paid generation is enabled by installation. The HTTP routes use ComfyUI's existing access boundary; put authentication and TLS in front of a remote deployment.

## Development

Run these commands from a Git checkout of DMAI NODES, with Node.js 22 or newer for JavaScript tests. The install ZIP does not include the test suites.

```bash
python -m unittest discover -s tests -v
node --test tests-js/*.test.mjs
python tools/build_release.py
```

The optional real-Comfy CPU LoRA comparison is described in `docs/VALIDATION.md`. Builds include only allowlisted source, docs, workflows and fonts.

MIT © 2026 DMAI / ceroomedia. [Third-party notices](THIRD_PARTY_NOTICES.md).
