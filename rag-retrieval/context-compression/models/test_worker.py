"""Pure helper tests: no torch/transformers imports, model loads or downloads."""
import os
import sys
import unittest
from unittest.mock import patch

from worker import aggregate_words, run, utf16_offsets


class HelpersTest(unittest.TestCase):
    def test_unicode_offsets(self):
        self.assertEqual(utf16_offsets("A🧭é"), [0, 1, 3, 4])

    def test_word_pooling_preserves_whitespace_and_utf16(self):
        source = "A🧭  refund"
        result = aggregate_words(source, [(0, 1, 0.2), (1, 2, 0.4), (4, 7, 0.8), (7, 10, 1.0)])
        self.assertAlmostEqual(result[0]["score"], 0.3)
        self.assertEqual(result[0]["end"], 3)
        self.assertEqual(result[1]["start"], 3)
        self.assertAlmostEqual(result[1]["score"], 0.9)

    def test_uncovered_word_is_an_error(self):
        with self.assertRaisesRegex(ValueError, "cover"):
            aggregate_words("missing", [])

    def test_disabled_gate_precedes_any_model_library_import(self):
        before = ("torch" in sys.modules, "transformers" in sys.modules)
        with patch.dict(os.environ, {"ENABLE_LOCAL_MODELS": "0"}):
            with self.assertRaisesRegex(RuntimeError, "disabled"):
                run({"method": "semantic"})
        self.assertEqual(before, ("torch" in sys.modules, "transformers" in sys.modules))




class ReferenceArgumentsTest(unittest.TestCase):
    def test_reference_rate_and_query_conditioning_without_importing_models(self):
        from reference import reference_arguments
        base = {"method": "llmlingua", "source": "source", "query": "question", "units": ["first", "second"], "remove": 40}
        plain = reference_arguments(base)
        self.assertEqual(plain["rate"], 0.6)
        self.assertEqual(plain["question"], "")
        self.assertFalse(plain["concate_question"])
        long = reference_arguments({**base, "method": "longllmlingua"})
        self.assertTrue(long["condition_compare"])
        self.assertEqual(long["rank_method"], "longllmlingua")
        self.assertEqual(long["condition_in_question"], "after_condition")
        self.assertEqual(long["context"], ["first", "second"])
        self.assertEqual(long["reorder_context"], "sort")

    def test_reference_gate_precedes_library_import(self):
        from reference import run_reference
        with patch.dict(os.environ, {"ENABLE_LOCAL_MODELS": "0"}):
            with self.assertRaisesRegex(RuntimeError, "disabled"):
                run_reference({})

    def test_reference_call_is_mocked_and_weights_are_offline_only(self):
        from reference import run_reference
        from types import SimpleNamespace
        seen = {}

        class MockCompressor:
            def __init__(self, **kwargs):
                seen.update(kwargs)
                self.tokenizer = lambda text, **kwargs: {"input_ids": [1, 2]}
                self.model = SimpleNamespace(config=SimpleNamespace(max_position_embeddings=2048))

            def compress_prompt(self, **kwargs):
                seen["args"] = kwargs
                return {"compressed_prompt": "MOCK output, no inference"}

        with patch.dict(os.environ, {"ENABLE_LOCAL_MODELS": "1"}):
            result = run_reference({"method": "longllmlingua", "source": "source", "query": "q", "units": ["source"], "remove": 50}, MockCompressor)
        self.assertTrue(seen["model_config"]["local_files_only"])
        self.assertFalse(seen["model_config"]["trust_remote_code"])
        self.assertIn("MOCK", result["text"])


if __name__ == "__main__":
    unittest.main()
