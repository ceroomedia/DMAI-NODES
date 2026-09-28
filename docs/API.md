# API workflows

DMAI NODES uses ComfyUI's native queue and workflow API. The node configs work without the custom frontend; image count, LoRA order, seed handling and validation run on the server.

## Submit a workflow

Start ComfyUI, select model files in a starter workflow, and export it in **API format**. The included `*.api.json` examples can also be edited directly. UI workflow JSON and API workflow JSON have different structures.

```bash
python custom_nodes/DMAI-NODES/tools/run_workflow.py \
  --url http://127.0.0.1:8188 \
  --prompt "A sculptural object in soft studio light" \
  --count 2 --seed 481516 --gallery website-demo --wait
```

Run the command from your ComfyUI directory using its Python environment. The default example uses Krea Original and its optional enhancer. Use `--workflow` for a different included API example. The helper expects starter node IDs `1` (Prompter), `3` (Engine) and `4` (Gallery); adapt these lookups before using a workflow with different IDs. For the SDXL example, `--checkpoint` can set the installed checkpoint filename. Edit model selections in other API examples to match your catalog. This command queues real generation on your own server.

1. `POST /prompt` with `{"prompt": <API workflow>, "client_id": "<unique ID>"}`.
2. Keep the returned `prompt_id`.
3. Read `GET /history/{prompt_id}` for completion or errors. Comfy's `/ws` stream is available for progress.
4. Read Gallery output metadata or the gallery route below to fetch originals.

In a completed starter job, Gallery metadata is at `history[prompt_id]["outputs"]["4"]["dmai_gallery"][0]`. Its `items` contain original and thumbnail URLs. Use your Gallery node ID instead of `"4"` for other workflows. The Gallery does not emit Comfy's native UI `images` field; its typed IMAGE output remains available to downstream nodes. The paginated gallery route provides the full saved history.

Use seed strings for the full unsigned 64-bit range; JavaScript numbers cannot represent all of it exactly. Each image's exact seed is recorded in the Engine report. The CLI timeout only stops waiting; it does not cancel the job.

## Generation progress over WebSocket

Connect to ComfyUI's `/ws?clientId=<client ID>` before submitting the workflow. Use the same ID as `client_id` in `POST /prompt`. The Engine sends `dmai_generation_progress` messages to that client through ComfyUI's existing WebSocket:

```json
{
  "type": "dmai_generation_progress",
  "data": {
    "prompt_id": "<queued prompt ID>",
    "node_id": "3",
    "phase": "sampling",
    "image_index": 1,
    "image_count": 2,
    "value": 4,
    "max": 8,
    "fraction": 0.6842105263
  }
}
```

| Field | Meaning |
| --- | --- |
| `prompt_id` | Native ComfyUI execution ID; match it to the queued job. |
| `node_id` | Native executing Engine ID. Expanded subgraphs may use a different ID from the visible graph. |
| `phase` | `preparing`, `sampling`, `decoding`, `finalizing`, `complete`, `error` or `interrupted`. |
| `image_index` / `image_count` | Zero-based current image index and total requested images. |
| `value` / `max` | Current sampler progress counters; use them during `sampling`. |
| `fraction` | Monotonic completed-work fraction from 0 to 1 across this Engine invocation. |

When available, `display_node_id`, `real_node_id` and `parent_node_id` provide ComfyUI's native subgraph mapping. Clients must match both the job and the intended Engine; receiving an event for another node does not advance this Engine.

The fraction normalizes each image's native sampler updates to its resolved step count, adds one unit after each completed decode, and reserves one final unit for assembling the Engine result. It measures completed work, not elapsed time. Model loading stays at zero. A sampler that emits no native progress advances only when its call returns; no timer simulates sampling progress. Internal VAE updates are excluded from the sampler counters.

**Engine `complete` is not workflow completion.** Gallery or other downstream nodes may still be running. The Prompter caps its display at 99% until ComfyUI emits native `execution_success` for the same `prompt_id`, so saved results are available before 100% appears. Handle native `execution_error` and `execution_interrupted` as failure/cancellation, including failures after the Engine has finished. Cached Engines may emit no package progress events; use native execution events and `/history/{prompt_id}` to determine the job's final state.

Progress observers exist only for the duration of Engine execution and are removed after success, failure or interruption. No additional WebSocket server is required.

## Package endpoints

Routes are relative to ComfyUI's base URL. JSON responses use `{"ok": true, "data": ...}` or `{"ok": false, "error": ...}`. Downloads return file bytes.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/dmai-nodes/v1/health` | Package version and capability flags |
| GET | `/dmai-nodes/v1/bootstrap` | Model profiles, installed files, LoRAs, presets, runtime samplers and schedulers |
| POST | `/dmai-nodes/v1/presets/validate` | Validate a single JSON preset or pack |
| GET | `/dmai-nodes/v1/galleries/{gallery_id}?offset=0&limit=60` | Saved images, total and snapshot watermark |
| GET | `/dmai-nodes/v1/images/{image_id}` | Original PNG |
| GET | `/dmai-nodes/v1/images/{image_id}?thumbnail=1` | Small JPEG preview |
| GET | `/dmai-nodes/v1/images/{image_id}?download=1` | Original PNG with download disposition |
| POST | `/dmai-nodes/v1/galleries/{gallery_id}/zip` | Export selected original files |

ZIP body: `{"ids": ["<image ID>", "<image ID>"]}`. To export a stable full-history snapshot, use `{"all": true, "before": <watermark>}`. Exports require 1–100 images and at most 2 GiB of original bytes. Pagination with `before=<watermark>` excludes newer images. An invalid, missing or cross-gallery image fails the whole export.

Gallery IDs are 1–64 letters, numbers, underscores or hyphens, beginning with a letter or number. The UI creates a persistent ID for each new Gallery; API clients must choose their own. A shared ID intentionally means shared history.

Saved PNG metadata includes the prompt and workflow when provided by ComfyUI. Treat exported images as potentially containing their generation recipe.

## Connecting a future website

Use a server-side gateway between the website and ComfyUI:

```text
Website → authenticated application server → ComfyUI /prompt
        ← application job/result endpoint ← /history + Gallery
```

The application server should own approved workflow templates, model allowlists, user authorization, quotas and job IDs. Send user prompts and selected settings into those templates. Keep ComfyUI on a private network or behind an authenticated proxy and TLS. Do not place server credentials in browser JavaScript.

This release supplies the headless node contract and local Gallery API. It does not implement website accounts, tenant isolation, billing, authentication or a public job gateway. Gallery IDs identify collections; they are not access-control tokens. ComfyUI cancellation is server-wide unless your gateway coordinates ownership.

Official reference: [ComfyUI server routes](https://docs.comfy.org/development/comfyui-server/comms_routes).
