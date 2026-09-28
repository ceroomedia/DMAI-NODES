"""Scoped, execution-specific progress events without patching Comfy callbacks."""
from __future__ import annotations

import logging
import math
from uuid import uuid4

logger = logging.getLogger(__name__)
EVENT_NAME = "dmai_generation_progress"


class GenerationProgress:
    """Observe only this engine's native sampler updates while it is sampling.

    Each image contributes its normalized sampler steps and one completed decode;
    a final unit covers assembling the result. This measures completed work, not
    elapsed time. Model loading remains indeterminate at zero. A sampler that
    does not report native progress advances only when its call actually returns.
    """

    def __init__(self, *, registry=None, send=None, prompt_id=None, node_id=None,
                 client_id=None, node_metadata=None):
        self.name = f"dmai-generation-{uuid4().hex}"
        self.enabled = registry is not None and send is not None and bool(prompt_id) and node_id is not None
        self.registry = registry
        self.send = send
        self.prompt_id = str(prompt_id) if prompt_id is not None else None
        self.node_id = str(node_id) if node_id is not None else None
        self.client_id = client_id
        self.node_metadata = node_metadata or {}
        self.image_count = 1
        self.image_index = 0
        self.steps = 1
        self.value = 0
        self.maximum = 1
        self.fraction = 0.0
        self.phase = "preparing"
        self._registered = False

    @classmethod
    def from_comfy(cls, node_id=None):
        """Direct library calls without a Comfy execution context stay silent."""
        try:
            from comfy_execution.utils import get_executing_context
            from comfy_execution.progress import get_progress_state
            context = get_executing_context()
            if context is None or not context.prompt_id:
                return cls()
            # Native execution IDs remain authoritative for expanded subgraphs.
            context_node_id = str(context.node_id)
            if node_id is not None and str(node_id) != context_node_id:
                return cls()
            registry = get_progress_state()
            if str(registry.prompt_id) != str(context.prompt_id):
                return cls()
            from server import PromptServer
            server = PromptServer.instance
            if server is None:
                return cls()
            metadata = {}
            for field in ("display_node_id", "parent_node_id", "real_node_id"):
                resolver = getattr(registry.dynprompt, f"get_{field}", None)
                if callable(resolver):
                    metadata[field] = resolver(context_node_id)
            return cls(registry=registry, send=server.send_sync, prompt_id=context.prompt_id,
                       node_id=context_node_id, client_id=server.client_id, node_metadata=metadata)
        except Exception:
            # Progress must never change the outcome of generation.
            logger.debug("DMAI generation progress is unavailable", exc_info=True)
            return cls()

    def __enter__(self):
        if self.enabled:
            try:
                self.registry.register_handler(self)
                self._registered = True
            except Exception:
                self.enabled = False
                logger.debug("Could not register DMAI generation progress", exc_info=True)
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        try:
            if exc_type is None:
                self.phase = "complete"
                self._emit(1.0)
            else:
                interrupted = isinstance(exc_value, InterruptedError) or any(
                    base.__name__ == "InterruptProcessingException" for base in exc_type.__mro__)
                self.phase = "interrupted" if interrupted else "error"
                self._emit(self.fraction)
        finally:
            if self._registered:
                try:
                    self.registry.unregister_handler(self.name)
                except Exception:
                    logger.debug("Could not unregister DMAI generation progress", exc_info=True)
                finally:
                    self._registered = False
            self.enabled = False
        return False

    def configure(self, image_count, steps):
        self.image_count = image_count
        self.steps = steps
        self.maximum = steps
        self._emit(0.0)

    def set_steps(self, steps):
        # Resolved external SIGMAS may replace the configured schedule.
        self.steps = steps
        self.maximum = steps

    @property
    def total_units(self):
        return self.image_count * (self.steps + 1) + 1

    def _image_units(self):
        return self.image_index * (self.steps + 1)

    def begin_sampling(self, index):
        self.image_index = index
        self.phase = "sampling"
        self.value = 0
        self.maximum = self.steps
        self._emit(self._image_units() / self.total_units)

    def begin_decode(self):
        self.phase = "decoding"
        self._emit((self._image_units() + self.steps) / self.total_units)

    def image_done(self):
        self.phase = "finalizing" if self.image_index + 1 == self.image_count else "decoding"
        self._emit(((self.image_index + 1) * (self.steps + 1)) / self.total_units)

    def _emit(self, fraction):
        self.fraction = min(1.0, max(self.fraction, fraction))
        if not self.enabled:
            return
        payload = {"prompt_id": self.prompt_id, "node_id": self.node_id,
                   "phase": self.phase, "image_index": self.image_index,
                   "image_count": self.image_count, "value": self.value,
                   "max": self.maximum, "fraction": self.fraction,
                   **self.node_metadata}
        try:
            self.send(EVENT_NAME, payload, self.client_id)
        except Exception:
            logger.debug("Could not send DMAI generation progress", exc_info=True)

    def update_handler(self, node_id, value, max_value, state, prompt_id, image=None):
        if (not self.enabled or self.phase != "sampling" or str(node_id) != self.node_id
                or str(prompt_id) != self.prompt_id):
            return
        try:
            value, maximum = float(value), float(max_value)
        except (TypeError, ValueError, OverflowError):
            return
        if not math.isfinite(value) or not math.isfinite(maximum) or maximum <= 0:
            return
        self.value, self.maximum = max(0.0, min(value, maximum)), maximum
        self._emit((self._image_units() + self.steps * self.value / maximum) / self.total_units)

    # Implement the native ProgressHandler interface without importing Comfy at
    # module import time, so lightweight package tooling remains usable.
    def set_registry(self, registry):
        self.registry = registry

    def start_handler(self, node_id, state, prompt_id):
        pass

    def finish_handler(self, node_id, state, prompt_id):
        pass

    def reset(self):
        self.enabled = False

    def enable(self):
        self.enabled = True

    def disable(self):
        self.enabled = False
