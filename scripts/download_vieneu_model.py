"""Download and validate the project-local VieNeu Nano model."""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
from pathlib import Path

MODEL_REPO = "pnnbao-ump/VieNeu-TTS-v3-Nano"
MODEL_REVISION = "aba295eb96a6fa6003ebe417cc1f2802a7adc1dc"
ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "server" / "models" / "vieneu-nano"
TEMP_CACHE = ROOT / "server" / "models" / ".download-cache"
OLD_CACHE = ROOT / "server" / "models" / "huggingface"
MODEL_FILES = (
    "text_encoder.onnx",
    "duration_predictor.onnx",
    "vector_estimator.onnx",
    "codec_decoder.onnx",
    "config.json",
    "constants.npz",
)
MODEL_SHA256 = {
    "codec_decoder.onnx": "b0ab15e7828a39d53679e25b1ba4ba415a61311307202a6323130b9e1cc3029d",
    "config.json": "3762f1716fd8d7a1451ddf2e051c03b0a341e8adda4f1dbd0db0ae9777514e56",
    "constants.npz": "7c011938effe41687a9af85107a31a040dfcf0fb3d0f048ec10f4fb65c1a8829",
    "duration_predictor.onnx": "20fd7fa60006d0a48ee82e0451b3f920d2052588c083c756cce669f3947c0a68",
    "text_encoder.onnx": "204f02cccae1f16ccb2d3840f05721a37fe250b82cbd456337a0ccb49615e4bf",
    "vector_estimator.onnx": "c6c1d4398ca35d3ad1bd3f0459413d1b975d09e7f2f3a2b4493a7b92bbf6ce93",
}


def download() -> None:
    from huggingface_hub import snapshot_download

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    os.environ["HF_HOME"] = str(TEMP_CACHE)
    snapshot_download(
        repo_id=MODEL_REPO,
        local_dir=str(MODEL_DIR),
        revision=MODEL_REVISION,
        allow_patterns=list(MODEL_FILES),
    )


def validate() -> None:
    missing = [name for name in MODEL_FILES if not (MODEL_DIR / name).is_file()]
    if missing:
        raise RuntimeError(f"Model thiếu file: {', '.join(missing)}")
    wrong = []
    for name, expected in MODEL_SHA256.items():
        digest = hashlib.sha256((MODEL_DIR / name).read_bytes()).hexdigest()
        if digest != expected:
            wrong.append(f"{name} (sha256 {digest})")
    if wrong:
        raise RuntimeError("Model sai checksum, xoá và tải lại: " + ", ".join(wrong))

    os.environ["VIENEU_MODEL_DIR"] = str(MODEL_DIR)
    from vieneu import Vieneu

    runtime = Vieneu(mode="v3nano", onnx_dir=str(MODEL_DIR))
    audio = runtime.infer("Xin chào, kiểm tra model VieNeu Nano.", apply_watermark=False)
    if len(audio) == 0:
        raise RuntimeError("Model khởi tạo được nhưng không tạo audio")


def clean_cache() -> None:
    for path in (TEMP_CACHE, MODEL_DIR / ".cache", OLD_CACHE):
        if path.exists():
            shutil.rmtree(path)


def main() -> None:
    global MODEL_DIR
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, default=MODEL_DIR)
    parser.add_argument("--keep-cache", action="store_true", help="Không xoá cache tải tạm/cũ")
    args = parser.parse_args()
    MODEL_DIR = args.model_dir.resolve()

    print(f"Downloading {MODEL_REPO} -> {MODEL_DIR}")
    download()
    print("Validating local ONNX model...")
    validate()
    if not args.keep_cache:
        clean_cache()
    print(f"Ready: {MODEL_DIR}")


if __name__ == "__main__":
    main()
