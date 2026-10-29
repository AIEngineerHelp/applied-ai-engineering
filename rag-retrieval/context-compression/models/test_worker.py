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


if __name__ == "__main__":
    unittest.main()
