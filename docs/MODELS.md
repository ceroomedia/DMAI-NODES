# Models and presets

Choose an installed file at the top of Generation Engine. The picker groups the running ComfyUI installation's files under **Checkpoints** and **Diffusion models**, including configured extra model paths and legacy `unet` folders. The list contains filenames, not architecture presets.

Open **Model files** below to choose **Architecture** and the matching text encoders and VAE. Checkpoints currently use the SDXL adapter and must include CLIP and VAE. Separate diffusion files use Krea 2 Turbo, Qwen Image or FLUX.1 Dev. Choose the architecture explicitly: the Engine does not infer it from a filename. A preset changes settings, not model support.

Use **Refresh model list** after adding files. Missing saved selections stay visible so you can replace them; an empty list means ComfyUI has no files in that category.

Choosing another file in the same category keeps your architecture, sampling settings, preset and supporting files. Switching categories restores that category's last architecture and saved settings, or its defaults. Changing **Architecture** within a category keeps the main filename and restores that architecture's encoder, VAE and settings selections. Confirm that the file matches the selected architecture before generating.

| Architecture | ComfyUI model folders and typical filenames |
| --- | --- |
| Krea 2 Turbo | `diffusion_models/krea2_turbo_fp8.safetensors`, `text_encoders/qwen3vl_4b_fp8_scaled.safetensors`, `vae/wan_2.1_vae.safetensors` |
| SDXL Checkpoint | A base SDXL checkpoint in `checkpoints`, including its CLIP and VAE |
| Qwen Image | `diffusion_models/qwen_image_fp8_e4m3fn.safetensors`, `text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors`, `vae/qwen_image_vae.safetensors` |
| FLUX.1 Dev | `diffusion_models/flux1-dev.safetensors`, `text_encoders/clip_l.safetensors`, `text_encoders/t5xxl_fp16.safetensors`, `vae/ae.safetensors` |

These are example filenames, not included downloads. Select the compatible files you have installed. SD 1.x/2.x checkpoints, Qwen Image Edit, Qwen Image 2.1, FLUX Kontext, FLUX.2, FLUX Schnell, SDXL Refiner, quantization extensions and video models are not covered by these adapters. The engine checks loaded model, text encoder and latent families before sampling. Variants that share the same architecture cannot always be distinguished, so select a model covered by the chosen adapter. GPU output quality has not yet been verified for this release.

## Manual or DMAI Enhanced

**Manual** exposes Steps, CFG, Sampler, Scheduler and Denoise. Choices come from the active ComfyUI sampler registry, including names registered by extensions. A name appearing in the registry does not prove it works with every model.

**DMAI Enhanced** selects a validated settings preset. The built-in Krea Original recipe uses 8 steps, CFG 1.1, Euler, Beta, denoise 1 and the Krea enhancer at strength 1 / text scale 1. Clean Base disables enhancement. SDXL, Qwen and FLUX base presets provide editable starting points, not quality guarantees.

FLUX.1 Dev uses embedded guidance 3.5; CFG is a separate parameter. Advanced users can supply both conditioning inputs, using Comfy's FluxGuidance upstream to change embedded guidance. External conditioning bypasses Prompter text encoding; apply any CLIP LoRAs before that external encoding and set the Engine recipe's CLIP strengths to zero. The Engine rejects active nonzero CLIP strengths with supplied conditioning.

The preset import button accepts a single preset or a pack of up to 20. Files are limited to 128 KiB. Unknown fields, model descriptors, non-finite values and unsupported sampling choices are rejected. Imported presets cannot replace built-in IDs. Use a new ID for your variation.

```json
{
  "schema_version": 1,
  "id": "dmai-sdxl-soft-v1",
  "name": "DMAI / SDXL Soft",
  "model": {"id": "sdxl-checkpoint", "label": "SDXL Checkpoint", "family": "sdxl"},
  "settings": {"steps": 24, "cfg": 6, "sampler": "euler", "scheduler": "normal", "denoise": 1, "enhancer": "none"}
}
```

Preset files contain data only. They cannot download models, execute Python or register adapters. See `resources/presets/dmai-presets-v1.json` for the built-in pack.

## Krea enhancer as a separate node

Connect a Krea MODEL through **DMAI Krea Enhancer**, then to Engine's advanced MODEL input. Also connect matching CLIP and VAE. Select Krea Clean Base or Manual with enhancement `none` in Engine when the upstream node has already applied it. Double enhancement is rejected.

The standalone node requires the separately installed, reviewed [Krea2T Enhancer](https://github.com/capitan01R/ComfyUI-Krea2T-Enhancer). It exposes Enabled, Strength and Text scale. It rejects non-Krea models when enabled. Qwen, FLUX and SDXL never receive this enhancement. See [installation](INSTALLATION.md#optional-krea-enhancement) for the pinned dependency.

## Advanced connections

Drag ComfyUI's native output ports to matching input ports. The basic links are Prompter **request** → Engine **request**, LoRA Loader **loras** → Engine **loras**, Engine **images** → Gallery **images**, and optionally Engine **report** → Gallery **report**. These are workflow connections, separate from buttons inside the node panels.

Reveal optional advanced inputs using ComfyUI's native node controls.

| Input | Behavior |
| --- | --- |
| MODEL + CLIP + VAE | Supply all three together to bypass Engine's internal file loaders. The selected Architecture still validates their compatibility; local file selections are not required for this path. |
| SAMPLER | Use the connected sampler object. Engine calculates the schedule from its Steps, Scheduler and Denoise. |
| SIGMAS | Supply the schedule tensor. This overrides Steps, Scheduler and Denoise. Engine still selects its own sampler unless SAMPLER is also connected. |
| LATENT | Start from one encoded image matching Prompter dimensions. It is reused with a different seed for each requested output. Choose denoise below 1 for image-to-image. |
| positive + negative | Supply both CONDITIONING objects together. These override internal text encoding. LoRAs supplied to Engine can no longer change already encoded text. |

SIGMAS must contain 2–10001 finite floating-point values in a one-dimensional tensor descending strictly to zero. When connecting only SAMPLER, use Denoise greater than zero: Comfy's BasicScheduler returns an empty schedule at zero, which the Engine rejects. Callbacks and RES4LYF unsample/resample modes are rejected. See [RES4LYF](RES4LYF.md) for sampler-specific wiring and limits.

## VAE Encode and Decode

**DMAI VAE Encode:** Load Image → images, matching VAE → vae, then latent → Engine's LATENT input. Set Prompter dimensions to the encoded image dimensions. Supply one encoded image; it is reused across the requested count.

**DMAI VAE Decode:** external sampler LATENT + matching VAE → images → Gallery. This also supports full RES4LYF sampler nodes that output LATENT instead of a SAMPLER object.

Engine already decodes its normal IMAGE output. The separate nodes expose the same standard Comfy operations for custom workflows. Model-specific divisibility and image cropping still follow Comfy's VAE behavior.

## LoRA behavior

The LoRA Loader produces an ordered recipe. Engine applies it before encoding both prompts. Use the row arrows to change the order. Model and CLIP strengths are separate; disabled rows and rows with both strengths at zero are skipped. Active nonzero rows fail on missing or ambiguous paths or zero effective matches. Partial matches appear in the execution report.

File names preserve case and subfolders. Active file content hashes participate in cache invalidation. Registered patches are compared to Comfy's standard loader in CPU tests; visual compatibility with every LoRA is not guaranteed.

## Dimensions and batches

Prompter offers 19 ratios, 1K / 2K long-edge targets and Custom dimensions. Dimensions must be multiples of 64, at least 64 pixels, at most 8192 per side and at most 16,777,216 pixels total. Image count is 1–8. Engine generates images sequentially with seeds incremented modulo 2^64.

An interrupted or failed Engine execution does not send a partial batch to Gallery. Existing saved gallery images remain available.
