"""DMAI NODES: an independent ComfyUI V3 extension."""
from .dmai_nodes.extension import comfy_entrypoint
from .dmai_nodes import __version__

WEB_DIRECTORY = "./web"
__all__ = ["comfy_entrypoint", "WEB_DIRECTORY", "__version__"]
