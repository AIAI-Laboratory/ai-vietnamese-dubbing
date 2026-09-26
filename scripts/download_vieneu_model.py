"""Download and validate the project-local VieNeu Nano model."""

from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path

MODEL_REPO = "pnnbao-ump/VieNeu-TTS-v3-Nano"
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


def download() -> None:
    from huggingface_hub import snapshot_download

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    os.environ["HF_HOME"] = str(TEMP_CACHE)
    snapshot_download(
        repo_id=MODEL_REPO,
        local_dir=str(MODEL_DIR),
        allow_patterns=list(MODEL_FILES),
    )


def validate() -> None:
    missing = [name for name in MODEL_FILES if not (MODEL_DIR / name).is_file()]
    if missing:
        raise RuntimeError(f"Model thiếu file: {', '.join(missing)}")

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
