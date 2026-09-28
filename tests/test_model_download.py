import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "download_vieneu_model.py"
SPEC = importlib.util.spec_from_file_location("download_vieneu_model", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ModelProvenanceTest(unittest.TestCase):
    def test_model_download_is_pinned_and_hashed(self):
        self.assertEqual(MODULE.MODEL_REVISION, "aba295eb96a6fa6003ebe417cc1f2802a7adc1dc")
        self.assertEqual(set(MODULE.MODEL_SHA256), set(MODULE.MODEL_FILES))
        self.assertTrue(all(len(value) == 64 for value in MODULE.MODEL_SHA256.values()))


if __name__ == "__main__":
    unittest.main()
