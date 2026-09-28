"""Progress measures native work and never changes execution or cache results."""
import math
import sys
import types
import unittest
from unittest.mock import patch

from dmai_nodes.progress import EVENT_NAME, GenerationProgress


class Registry:
    def __init__(self, prompt_id="job-1"):
        self.prompt_id = prompt_id
        self.handlers = {}
        self.dynprompt = types.SimpleNamespace(
            get_display_node_id=lambda node_id: "visible-engine",
            get_real_node_id=lambda node_id: node_id,
            get_parent_node_id=lambda node_id: None)

    def register_handler(self, handler):
        self.handlers[handler.name] = handler

    def unregister_handler(self, name):
        self.handlers[name].reset()
        del self.handlers[name]

    def update(self, value, maximum, node_id="engine-1", prompt_id="job-1"):
        for handler in list(self.handlers.values()):
            if handler.enabled:
                handler.update_handler(node_id, value, maximum, {}, prompt_id)


class ProgressTests(unittest.TestCase):
    def make_progress(self, send=None):
        self.registry = Registry()
        self.events = []
        return GenerationProgress(registry=self.registry,
                                  send=send or (lambda event, payload, sid: self.events.append((event, payload, sid))),
                                  prompt_id="job-1", node_id="engine-1", client_id="owner-client")

    def test_two_images_include_decode_and_complete_only_after_success(self):
        progress = self.make_progress()
        with progress:
            progress.configure(2, 3)
            for index in range(2):
                progress.begin_sampling(index)
                self.registry.update(1, 3)
                self.registry.update(3, 3)
                self.assertLess(self.events[-1][1]["fraction"], 1)
                progress.begin_decode()
                progress.image_done()
            self.assertEqual(self.events[-1][1]["phase"], "finalizing")
            self.assertAlmostEqual(self.events[-1][1]["fraction"], 8 / 9)
            self.assertEqual(len(self.registry.handlers), 1)
        self.assertEqual(self.registry.handlers, {})
        self.assertEqual(self.events[-1][1]["phase"], "complete")
        self.assertEqual(self.events[-1][1]["fraction"], 1)
        sampling = [event[1] for event in self.events if event[1]["phase"] == "sampling" and event[1]["value"] == 1]
        self.assertEqual([item["image_index"] for item in sampling], [0, 1])
        self.assertAlmostEqual(sampling[0]["fraction"], 1 / 9)
        self.assertAlmostEqual(sampling[1]["fraction"], 5 / 9)
        self.assertEqual([e[1]["fraction"] for e in self.events], sorted(e[1]["fraction"] for e in self.events))
        self.assertTrue(all(event == EVENT_NAME and sid == "owner-client" for event, _, sid in self.events))

    def test_unrelated_jobs_nodes_and_vae_updates_do_not_change_sampling(self):
        progress = self.make_progress()
        with progress:
            progress.configure(1, 10)
            self.registry.update(10, 10)  # Preparing/model load, not sampling.
            progress.begin_sampling(0)
            before = len(self.events)
            self.registry.update(10, 10, node_id="another-engine")
            self.registry.update(10, 10, prompt_id="another-job")
            self.assertEqual(len(self.events), before)
            self.registry.update(4, 10)
            self.assertEqual(self.events[-1][1]["value"], 4)
            progress.begin_decode()
            before = len(self.events)
            self.registry.update(100, 100)  # Same node's VAE internal progress.
            progress.finish_handler("engine-1", {}, "job-1")
            self.assertEqual(len(self.events), before)
            progress.image_done()

    def test_invalid_counters_and_resetting_sampler_are_safe(self):
        progress = self.make_progress()
        with progress:
            progress.configure(1, 8)
            progress.begin_sampling(0)
            before = len(self.events)
            for value, maximum in ((1, 0), (math.nan, 8), (1, math.inf), ("bad", 8), (1, None)):
                self.registry.update(value, maximum)
            self.assertEqual(len(self.events), before)
            self.registry.update(4, 8)
            fraction = progress.fraction
            self.registry.update(1, 8)
            self.assertEqual(progress.fraction, fraction)
            self.registry.update(20, 8)
            self.assertLess(progress.fraction, 1)

    def test_external_schedule_replaces_configured_steps(self):
        progress = self.make_progress()
        with progress:
            progress.configure(2, 20)
            progress.set_steps(3)
            progress.begin_sampling(1)
            self.registry.update(2, 3)
            self.assertAlmostEqual(progress.fraction, 6 / 9)

    def test_sampler_without_updates_advances_on_return_and_decode(self):
        progress = self.make_progress()
        with progress:
            progress.configure(1, 4)
            progress.begin_sampling(0)
            self.assertEqual(progress.fraction, 0)
            progress.begin_decode()
            self.assertAlmostEqual(progress.fraction, 4 / 6)
            progress.image_done()
            self.assertAlmostEqual(progress.fraction, 5 / 6)

    def test_failures_and_native_interrupts_unregister_without_completing(self):
        class InterruptProcessingException(Exception):
            pass
        for error, phase in ((RuntimeError("sample failed"), "error"),
                             (InterruptedError("cancelled"), "interrupted"),
                             (InterruptProcessingException(), "interrupted")):
            with self.subTest(phase=phase):
                progress = self.make_progress()
                with self.assertRaises(type(error)):
                    with progress:
                        progress.configure(2, 8)
                        progress.begin_sampling(0)
                        self.registry.update(2, 8)
                        raise error
                self.assertEqual(self.registry.handlers, {})
                self.assertFalse(progress.enabled)
                self.assertEqual(self.events[-1][1]["phase"], phase)
                self.assertLess(progress.fraction, 1)
                self.assertFalse(any(event[1]["phase"] == "complete" for event in self.events))

    def test_event_transport_failure_never_breaks_generation_or_cleanup(self):
        def disconnected(*_):
            raise RuntimeError("socket closed")
        progress = self.make_progress(send=disconnected)
        with progress:
            progress.configure(1, 4)
            progress.begin_sampling(0)
            self.registry.update(4, 4)
            progress.begin_decode()
            progress.image_done()
        self.assertEqual(self.registry.handlers, {})
        self.assertEqual(progress.fraction, 1)

    def test_progress_handlers_are_isolated_and_keep_existing_handlers(self):
        first = self.make_progress()
        existing = object()
        self.registry.handlers["existing"] = existing
        second = GenerationProgress(registry=self.registry, send=first.send, prompt_id="job-1", node_id="engine-2")
        with first, second:
            self.assertNotEqual(first.name, second.name)
            self.assertEqual(len(self.registry.handlers), 3)
        self.assertEqual(self.registry.handlers, {"existing": existing})

    def test_comfy_context_is_authoritative_and_captures_the_client(self):
        registry = Registry()
        sent = []
        context = types.SimpleNamespace(prompt_id="job-1", node_id="engine-1")
        runtime = types.ModuleType("comfy_execution")
        runtime.__path__ = []
        utils = types.SimpleNamespace(get_executing_context=lambda: context)
        native_progress = types.SimpleNamespace(get_progress_state=lambda: registry)
        server = types.SimpleNamespace(send_sync=lambda *args: sent.append(args), client_id="owner-client")
        modules = {"comfy_execution": runtime, "comfy_execution.utils": utils,
                   "comfy_execution.progress": native_progress,
                   "server": types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=server))}
        with patch.dict(sys.modules, modules):
            progress = GenerationProgress.from_comfy("engine-1")
            self.assertTrue(progress.enabled)
            server.client_id = "other-client"
            with progress:
                progress.configure(1, 4)
            self.assertTrue(all(event[2] == "owner-client" for event in sent))
            self.assertEqual(sent[-1][1]["display_node_id"], "visible-engine")
            self.assertFalse(GenerationProgress.from_comfy("wrong-node").enabled)
            registry.prompt_id = "other-job"
            self.assertFalse(GenerationProgress.from_comfy().enabled)
            context = None
            self.assertFalse(GenerationProgress.from_comfy().enabled)


if __name__ == "__main__":
    unittest.main()
