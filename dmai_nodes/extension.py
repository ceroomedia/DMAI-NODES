from comfy_api.latest import ComfyExtension
from .nodes import NODE_CLASSES
from .routes import register_routes


class DMAINodesExtension(ComfyExtension):
    async def on_load(self):
        register_routes()

    async def get_node_list(self):
        return NODE_CLASSES


async def comfy_entrypoint():
    return DMAINodesExtension()
