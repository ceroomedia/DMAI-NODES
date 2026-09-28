# RES4LYF with DMAI NODES

RES4LYF is an optional, separately installed extension. DMAI NODES can receive its standard `SAMPLER` output through the Generation Engine's advanced inputs. Its complete sampling nodes can also feed DMAI VAE Decode and Gallery.

Source review: September 28, 2026, upstream commit [`3d1d69d`](https://github.com/ClownsharkBatwing/RES4LYF/tree/3d1d69da69ee47f7647d59e1bd0967e472fccc41). This review establishes node interfaces and code behavior. It does **not** establish successful RES4LYF image generation with every DMAI model profile.

## Install separately

Follow [RES4LYF's installation instructions](https://github.com/ClownsharkBatwing/RES4LYF#installation) using the Python environment that runs ComfyUI. Restart ComfyUI afterward. DMAI NODES does not download, vendor or install RES4LYF automatically.

## Choose the right output

| RES4LYF node shown in ComfyUI | Node ID | Output to use |
|---|---|---|
| ClownSampler | `ClownSampler_Beta` | `sampler` → Engine `sampler` |
| ClownSamplerAdvanced | `ClownSamplerAdvanced_Beta` | `sampler` → Engine `sampler` |
| ClownsharKSampler | `ClownsharKSampler_Beta` | `output` or `denoised`, both `LATENT` → DMAI VAE Decode |
| SharkSampler | `SharkSampler_Beta` | `output` or `denoised`, both `LATENT` → DMAI VAE Decode |

The first two create sampler objects; the last two execute sampling. Their other `OPTIONS` outputs are not sampler objects. [Node registrations](https://github.com/ClownsharkBatwing/RES4LYF/blob/3d1d69da69ee47f7647d59e1bd0967e472fccc41/beta/__init__.py), [sampler schemas](https://github.com/ClownsharkBatwing/RES4LYF/blob/3d1d69da69ee47f7647d59e1bd0967e472fccc41/beta/samplers.py).

`ClownSamplerSelector` (`ClownSamplerSelector_Beta`) returns a sampler **name**, not a `SAMPLER`; connect it to a compatible RES4LYF name input. [Selector source](https://github.com/ClownsharkBatwing/RES4LYF/blob/3d1d69da69ee47f7647d59e1bd0967e472fccc41/beta/samplers_extensions.py).

## Use the Generation Engine

1. Connect Prompter `request` to Engine `request` and Engine `images` to Gallery `images`.
2. Open the Engine's advanced inputs. Connect ClownSampler `sampler` to Engine `sampler`.
3. Leave Engine `sigmas` disconnected to build the schedule from the Engine's selected model, scheduler, steps and denoise.
4. For a custom schedule, connect an actual `SIGMAS` tensor to Engine `sigmas`. Core **BasicScheduler** is a suitable source: use the same model for its schedule and the Engine. With external loaders, connect the matching `MODEL`, `CLIP` and `VAE` together to the Engine.

The connected sampler replaces the Engine's sampler selection. Connected sigmas replace its scheduler, steps and denoise schedule; those values do not reshape a supplied schedule. CFG, image count, initial seed and the selected model profile remain Engine controls. Prompter text is used unless both external conditioning inputs are connected. A connected sampler alone keeps the Engine's schedule controls; use Denoise greater than zero because Comfy's zero-denoise scheduler output is empty and the Engine rejects it. Connected sigmas alone keep its sampler choice. DMAI delegates this path to ComfyUI's [SamplerCustom](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_custom_sampler.py).

RES4LYF also registers some names, such as `res_2m`, `res_3m`, `beta57` and `bong_tangent`, in Comfy's sampler/scheduler registries. Available registered names appear in DMAI's selectors after a successful extension load. RES4LYF's larger internal sampler menu is not identical to that registry. [Sampler registration](https://github.com/ClownsharkBatwing/RES4LYF/blob/3d1d69da69ee47f7647d59e1bd0967e472fccc41/beta/__init__.py), [scheduler registration](https://github.com/ClownsharkBatwing/RES4LYF/blob/3d1d69da69ee47f7647d59e1bd0967e472fccc41/__init__.py).

## Schedule and seed details

- **Sigmas From Text** emits a tensor. DMAI requires 2–10001 finite floating-point values, strictly decreasing from a positive value to zero. Values must also suit the model. **ClownScheduler** has a `SIGMAS` label but returns a callback when its model is disconnected. With a model, its reviewed implementation builds a CUDA tensor and rescales/pads values for parameter modulation. Its defaults are not a ready denoising schedule. [Sigma node source](https://github.com/ClownsharkBatwing/RES4LYF/blob/3d1d69da69ee47f7647d59e1bd0967e472fccc41/sigmas.py).
- The Engine rejects an embedded `sigmas_override` and nonstandard sampler modes. Supply the schedule at the Engine input. RES4LYF may still transform it internally, for example through `d_noise`, duplicate removal or a model minimum sigma. The Engine's schedule report describes what it supplied to the sampler. [Schedule preparation](https://github.com/ClownsharkBatwing/RES4LYF/blob/3d1d69da69ee47f7647d59e1bd0967e472fccc41/beta/rk_noise_sampler_beta.py).
- RES4LYF's SDE seed is separate from the Engine's initial noise seed. Keep both values and the workflow when comparing runs. A negative RES4LYF seed can use internal RNG state rather than an explicit independent seed. [Noise initialization](https://github.com/ClownsharkBatwing/RES4LYF/blob/3d1d69da69ee47f7647d59e1bd0967e472fccc41/beta/rk_noise_sampler_beta.py).

## Use the complete RES4LYF workflow

Keep RES4LYF's own runner for unsampling, resampling, chain continuation and its associated state/options. Connect its final `LATENT` to **DMAI VAE Decode**, supply the matching VAE, then connect Decode `images` to **DMAI Gallery**. [Upstream workflow guide](https://github.com/ClownsharkBatwing/RES4LYF#new-version-documentation), [continuation implementation](https://github.com/ClownsharkBatwing/RES4LYF/blob/3d1d69da69ee47f7647d59e1bd0967e472fccc41/beta/rk_sampler_beta.py).

For Krea 2, the standalone **DMAI Krea Enhancer** can patch the model before an external runner. Enable enhancement once. Other model families are rejected by that node. A preset selects settings for a registered DMAI profile; importing one does not add support for a new architecture or RES4LYF-specific runner behavior.

**Validation boundary:** interface/source inspection is complete. RES4LYF was not installed or run for this review. Model-specific image quality, GPU behavior and complete RES4LYF workflows require separate runtime checks.
