# Installation

Use ComfyUI v0.37.0 as the initial reference. The package requires the V3 node API. Install dependencies with the Python that starts ComfyUI; a different system Python will not update that environment.

## Windows Portable

Open PowerShell in the portable folder containing `python_embeded` and `ComfyUI`:

```powershell
git clone https://github.com/ceroomedia/DMAI-NODES.git ComfyUI/custom_nodes/DMAI-NODES
.\python_embeded\python.exe -m pip install -r .\ComfyUI\custom_nodes\DMAI-NODES\requirements.txt
```

Without Git, extract the GitHub or Hugging Face release ZIP into `ComfyUI/custom_nodes`. The final path must be `ComfyUI/custom_nodes/DMAI-NODES/__init__.py`, with exactly one package folder.

Close and restart ComfyUI. Refresh the browser with Ctrl+F5. Search **DMAI** in the node library.

## Local Python environment

Activate the environment used by ComfyUI. From the ComfyUI folder:

```bash
git clone https://github.com/ceroomedia/DMAI-NODES.git custom_nodes/DMAI-NODES
python -m pip install -r custom_nodes/DMAI-NODES/requirements.txt
python main.py
```

For ComfyUI Desktop, use the installation directory shown in Desktop's settings and its managed Python environment. Do not install another GPU build of PyTorch just for DMAI NODES; this package uses ComfyUI's existing runtime.

## Runpod

1. Start your chosen ComfyUI Pod using your normal template and persistent volume. GPU availability, model licenses and Pod cost are separate from this package.
2. Open the Pod terminal and find the actual ComfyUI folder. Common examples are `/workspace/ComfyUI` and `/workspace/runpod-slim/ComfyUI`; templates differ.
3. Activate the same environment as the running ComfyUI server. Check its launcher if unsure.
4. Run the commands below, adjusting the path when needed.

```bash
cd /workspace/ComfyUI
git clone https://github.com/ceroomedia/DMAI-NODES.git custom_nodes/DMAI-NODES
python -m pip install -r custom_nodes/DMAI-NODES/requirements.txt
```

5. Store the model files and `output` directory on persistent storage. Match the files to [MODELS.md](MODELS.md).
6. Restart ComfyUI through the template's existing launcher and refresh its browser page. Use the template's authenticated access method; do not add an unauthenticated public endpoint for this package.
7. Import a starter workflow, choose installed files and generate one small image first.

The instructions do not start a Pod or buy compute. No Runpod template installation has been certified by this release's local CPU checks.

## Optional Krea enhancement

The **DMAI Krea Enhancer**, Manual sampling with Enhancer set to `krea2t`, and any preset enabling that enhancer require the upstream extension. The historical **Krea / Original** recipe also enables it. New nodes and starter workflows leave enhancement at `none`. From the ComfyUI directory:

```bash
git clone https://github.com/capitan01R/ComfyUI-Krea2T-Enhancer.git custom_nodes/ComfyUI-Krea2T-Enhancer
git -C custom_nodes/ComfyUI-Krea2T-Enhancer checkout e1f60f79e168c62b1cb1cf773dfb3ae4ee2292e2
```

Restart ComfyUI. The adapter recognizes reviewed upstream versions 1.1.0 and 1.4.2 and verifies their implementation. An unknown modification is rejected with a clear error. The original workflow used 1.1.0; the command above pins 1.4.2. Settings match the original recipe; visual equivalence between enhancer versions has not been established.

RES4LYF is optional and installed separately. Follow its upstream instructions and [the integration guide](RES4LYF.md).

## Update and remove

Update only when no job is running. To install **0.2.0 preview**, including from a checkout pinned to an older release, run from the ComfyUI directory with its Python environment active:

```bash
git -C custom_nodes/DMAI-NODES fetch origin tag v0.2.0
git -C custom_nodes/DMAI-NODES checkout v0.2.0
python -m pip install -r custom_nodes/DMAI-NODES/requirements.txt
git -C custom_nodes/DMAI-NODES describe --tags --exact-match
```

For Windows Portable, run from the portable folder instead:

```powershell
git -C .\ComfyUI\custom_nodes\DMAI-NODES fetch origin tag v0.2.0
git -C .\ComfyUI\custom_nodes\DMAI-NODES checkout v0.2.0
.\python_embeded\python.exe -m pip install -r .\ComfyUI\custom_nodes\DMAI-NODES\requirements.txt
git -C .\ComfyUI\custom_nodes\DMAI-NODES describe --tags --exact-match
```

The final command should print `v0.2.0`. Git's detached HEAD message is expected when selecting a fixed release tag. If Git reports local changes, preserve those changes before retrying; the commands above do not discard them.

Restart ComfyUI afterward, then hard-refresh with Ctrl+F5. For ZIP installations, replace package files from the new release while preserving your workflows and output. To uninstall, remove only the custom-node folder after stopping ComfyUI. Saved originals and the gallery index are in `output/DMAI-NODES` and are not removed by package updates.

### What changes in 0.2.0

The larger interface adds readable Canvas socket captions and minimum node sizes. Saved nodes may grow to the new minimum dimensions on load; their IDs and connections remain unchanged. Manual is the default for new Engines and starter workflows. Existing workflows retain their saved sampling settings and any selected historical preset.

For new prepared settings, switch to **DMAI Enhanced** and choose **Upload JSON**. Upload is available only in that mode. The old preset export control is removed. Keep your original preset files; existing imported presets remain saved in the workflow. See [sampling modes and legacy preset compatibility](MODELS.md#manual-or-dmai-enhanced).

### Updating from 0.1.2 or earlier

Since 0.1.3, the new Prompter registers as `DMAINodesPrompter`. Its visible name remains **DMAI Prompter**, under **DMAI NODES**, with the **DMAI-NODES** package badge. Older DMAI Suite and standalone Prompter installations use `DMAIPrompter`; they can remain enabled alongside this package. Version 0.2.0 keeps that separation.

To install exactly this release from an existing Git checkout, including a checkout pinned to an older tag, run inside `custom_nodes/DMAI-NODES`:

```bash
git fetch origin tag v0.2.0
git checkout v0.2.0
python -m pip install -r requirements.txt
git describe --tags --exact-match
```

Use ComfyUI's Python environment for the dependency command; Windows Portable uses `..\..\..\python_embeded\python.exe` from that node directory. Restart ComfyUI, then hard-refresh the browser with Ctrl+F5.

UI workflows saved by DMAI NODES 0.1.0-0.1.2 are upgraded on load only when their Prompter data and output identify this package. Save the workflow after loading it. Legacy Suite/standalone Prompters keep their original IDs and connections. Ambiguous or damaged records are left for manual correction.

For API JSON sent directly to `/prompt`, use the new `DMAINodesPrompter` class type. The included API helper and offline conversion tool handle identifiable older DMAI NODES API workflows; see [API migration](API.md#prompter-id-migration). The server does not register the conflicting old ID as an alias.

## Troubleshooting

- **No DMAI nodes:** inspect the ComfyUI console for import errors; check the Python environment and one-level ZIP extraction.
- **Prompter missing when older DMAI nodes are installed:** update to 0.2.0 using the commands above, restart ComfyUI and hard-refresh. The coexistence fix was introduced in 0.1.3. Search `DMAINodesPrompter` or select **DMAI Prompter** with the **DMAI-NODES** badge. The new node has a `request` output of type `DMAI_PROMPT`, captioned **Prompt** in Canvas.
- **Missing model:** select the exact catalog entry, including subfolder. Refresh the model list after adding files.
- **Enhancer unavailable:** install the pinned dependency or use Manual with Enhancer set to `none`.
- **Enhanced asks for a preset:** choose **Upload JSON** in DMAI Enhanced and upload matching settings, or switch to Manual.
- **LoRA has no matching patches:** verify the LoRA family and selected base model; this is deliberately an error.
- **Gallery missing original:** restore the file from your backup. An export will not silently omit a selected missing file.
- **Frontend layout issue:** hard-refresh first, then test Comfy's Canvas renderer. Socket captions are drawn outside the node; leave room between neighboring nodes. Keep the exact Core and Frontend versions in your issue report.

Official references: [Portable](https://docs.comfy.org/installation/comfyui_portable_windows), [manual installation](https://docs.comfy.org/installation/manual_install), [Runpod ComfyUI guide](https://docs.runpod.io/tutorials/pods/comfyui).
