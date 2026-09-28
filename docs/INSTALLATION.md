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
2. Open the Pod terminal and find the actual ComfyUI folder. `/workspace/ComfyUI` is common; templates differ.
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

The **DMAI Krea Enhancer** and **Krea / Original** preset require the upstream extension. From the ComfyUI directory:

```bash
git clone https://github.com/capitan01R/ComfyUI-Krea2T-Enhancer.git custom_nodes/ComfyUI-Krea2T-Enhancer
git -C custom_nodes/ComfyUI-Krea2T-Enhancer checkout e1f60f79e168c62b1cb1cf773dfb3ae4ee2292e2
```

Restart ComfyUI. The adapter recognizes reviewed upstream versions 1.1.0 and 1.4.2 and verifies their implementation. An unknown modification is rejected with a clear error. The original workflow used 1.1.0; the command above pins 1.4.2. Settings match the original recipe; visual equivalence between enhancer versions has not been established.

RES4LYF is optional and installed separately. Follow its upstream instructions and [the integration guide](RES4LYF.md).

## Update and remove

Update only when no job is running. From the ComfyUI directory with its Python environment active:

```bash
git -C custom_nodes/DMAI-NODES pull --ff-only
python -m pip install -r custom_nodes/DMAI-NODES/requirements.txt
```

For Windows Portable, run from the portable folder instead:

```powershell
git -C .\ComfyUI\custom_nodes\DMAI-NODES pull --ff-only
.\python_embeded\python.exe -m pip install -r .\ComfyUI\custom_nodes\DMAI-NODES\requirements.txt
```

Restart ComfyUI afterward. For ZIP installations, replace package files from the new release while preserving your workflows and output. To uninstall, remove only the custom-node folder after stopping ComfyUI. Saved originals and the gallery index are in `output/DMAI-NODES` and are not removed by package updates.

## Troubleshooting

- **No DMAI nodes:** inspect the ComfyUI console for import errors; check the Python environment and one-level ZIP extraction.
- **Missing model:** select the exact catalog entry, including subfolder. Refresh the model list after adding files.
- **Enhancer unavailable:** install the pinned dependency or choose Clean Base/Manual with `none`.
- **LoRA has no matching patches:** verify the LoRA family and selected base model; this is deliberately an error.
- **Gallery missing original:** restore the file from your backup. An export will not silently omit a selected missing file.
- **Frontend layout issue:** refresh first, then test Comfy's Canvas renderer. Keep the exact Core and Frontend versions in your issue report.

Official references: [Portable](https://docs.comfy.org/installation/comfyui_portable_windows), [manual installation](https://docs.comfy.org/installation/manual_install), [Runpod ComfyUI guide](https://docs.runpod.io/tutorials/pods/comfyui).
