"""
Chạy Kokoro-Vietnamese ONNX chỉ với numpy + onnxruntime.

Thay cho gói `kokoro-vietnamese` (Apache-2.0, github.com/iamdinhthuan/
Kokoro-Vietnamese): đường ONNX của gói đó chỉ làm bốn việc — tách câu, đổi
chữ sang phoneme, tra style vector theo số phoneme, gọi session.run — nhưng
lại khai gradio, torch và transformers là dependency CỨNG. Đo trên máy dev:
torch 490 MB, transformers 102 MB, gradio 78 MB trong tổng 1079 MB
site-packages, trong khi torch chỉ được dùng đúng một dòng `torch.load` để
đọc file voicepack 512 KB.

Module này giữ nguyên thuật toán đó nên âm thanh phát ra không đổi, và bỏ
được cả ba gói kia. Phần G2P vẫn dùng vig2p (chỉ phụ thuộc sea-g2p, không
kéo theo gì nặng).
"""

from __future__ import annotations

import json
import os
import pickle
import re
import threading
import zipfile
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download

REPO_ID = "contextboxai/Kokoro-Vietnamese"
ONNX_FILE = "kokoro_vi.onnx"
CONFIG_FILE = "config.json"
DEFAULT_VOICE = "diem_trinh"
SAMPLE_RATE = 24000
DEFAULT_CROSSFADE_MS = 50

VOICES = {
    "diem_trinh": {"label": "Diễm Trinh", "filename": "voicepacks/diem_trinh.pt"},
    "hung_thinh": {"label": "Hưng Thịnh", "filename": "voicepacks/hung_thinh.pt"},
    "mai_linh": {"label": "Mai Linh", "filename": "voicepacks/mai_linh.pt"},
    "mai_loan": {"label": "Mai Loan", "filename": "voicepacks/mai_loan.pt"},
    "manh_dung": {"label": "Mạnh Dũng", "filename": "voicepacks/manh_dung.pt"},
    "my_yen": {"label": "Mỹ Yến", "filename": "voicepacks/my_yen.pt"},
    "ngoc_huyen": {"label": "Ngọc Huyền", "filename": "voicepacks/ngoc_huyen.pt"},
    "phat_tai": {"label": "Phát Tài", "filename": "voicepacks/phat_tai.pt"},
    "thanh_dat": {"label": "Thành Đạt", "filename": "voicepacks/thanh_dat.pt"},
    "thuc_trinh": {"label": "Thục Trinh", "filename": "voicepacks/thuc_trinh.pt"},
    "tuan_ngoc": {"label": "Tuấn Ngọc", "filename": "voicepacks/tuan_ngoc.pt"},
    "storyvert": {"label": "storyvert", "filename": "voicepacks/storyvert.pt"},
    "duc_an": {"label": "Đức An", "filename": "voicepacks/duc_an.pt"},
    "duc_duy": {"label": "đức duy", "filename": "voicepacks/duc_duy.pt"},
}

# Kiểu lưu trữ của torch.save -> kiểu numpy tương ứng.
_STORAGE_DTYPES = {
    "FloatStorage": np.dtype("<f4"),
    "HalfStorage": np.dtype("<f2"),
    "DoubleStorage": np.dtype("<f8"),
    "LongStorage": np.dtype("<i8"),
    "IntStorage": np.dtype("<i4"),
}


def load_voicepack(path: str | Path) -> np.ndarray:
    """Đọc file voicepack .pt mà không cần torch.

    torch.save ghi ra một file ZIP: `data.pkl` là pickle của cấu trúc tensor,
    còn số liệu thô nằm trong `data/<key>`. Unpickler dưới đây chỉ chấp nhận
    đúng những lớp cần cho một tensor thường — bất cứ tên nào khác đều bị từ
    chối, nên file lạ không chạy được code tuỳ ý qua pickle.
    """

    with zipfile.ZipFile(path) as archive:
        pickle_name = next(
            (n for n in archive.namelist() if n.endswith("data.pkl")), ""
        )
        if not pickle_name:
            raise ValueError(f"{path} không phải file voicepack torch (thiếu data.pkl)")
        prefix = pickle_name[: -len("data.pkl")]

        def rebuild(storage, offset, size, stride, *_rest):
            # as_strided KHÔNG kiểm biên (numpy nói rõ trong tài liệu): shape
            # và stride lấy từ file nên phải tự chốt, nếu không một voicepack
            # dựng sẵn sẽ đọc được vùng nhớ ngoài buffer.
            size, stride = tuple(size), tuple(stride)
            if len(size) != len(stride):
                raise ValueError("voicepack có shape và stride không cùng số chiều")
            if offset < 0 or any(dim < 0 for dim in size) or any(s < 0 for s in stride):
                raise ValueError("voicepack có offset/shape/stride âm")
            available = len(storage) - offset
            if available < 0:
                raise ValueError("voicepack có offset vượt quá dữ liệu")
            # Phần tử xa nhất mà view chạm tới, tính theo chỉ số phần tử.
            furthest = sum((dim - 1) * s for dim, s in zip(size, stride) if dim > 0)
            if size and furthest + 1 > available:
                raise ValueError(
                    f"voicepack khai vùng dữ liệu {furthest + 1} phần tử nhưng chỉ có {available}"
                )
            view = np.lib.stride_tricks.as_strided(
                storage[offset:],
                shape=size,
                strides=tuple(s * storage.itemsize for s in stride),
            )
            return np.array(view, copy=True)

        class _TensorOnlyUnpickler(pickle.Unpickler):
            def find_class(self, module: str, name: str):
                if module == "torch._utils" and name in ("_rebuild_tensor_v2", "_rebuild_tensor"):
                    return rebuild
                if module == "torch" and name in _STORAGE_DTYPES:
                    return _STORAGE_DTYPES[name]
                if module == "collections" and name == "OrderedDict":
                    return dict
                raise pickle.UnpicklingError(f"voicepack chứa lớp không cho phép: {module}.{name}")

            def persistent_load(self, saved_id):
                kind, dtype, key, _location, numel = saved_id
                if kind != "storage":
                    raise pickle.UnpicklingError(f"kiểu lưu trữ lạ trong voicepack: {kind}")
                raw = archive.read(f"{prefix}data/{key}")
                return np.frombuffer(raw, dtype=dtype, count=numel)

        with archive.open(pickle_name) as handle:
            tensor = _TensorOnlyUnpickler(handle).load()

    array = np.asarray(tensor, dtype=np.float32)
    if array.ndim != 3 or array.shape[1:] != (1, 256):
        raise ValueError(f"voicepack phải có shape [n, 1, 256], nhận {array.shape}")
    return array


def split_text(text: str) -> list[str]:
    """Cắt theo dấu kết câu. Xem thêm fit_to_context cho mảnh vẫn quá dài."""

    normalized = re.sub(r"\s+", " ", text.strip())
    if not normalized:
        return []

    chunks: list[str] = []
    start = 0
    for match in re.finditer(r"[.!?…]+(?:[\"”’)]*)", normalized):
        end = match.end()
        if end < len(normalized) and not normalized[end].isspace():
            continue  # dấu chấm giữa từ (số thập phân, viết tắt)
        chunk = normalized[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start = end

    remainder = normalized[start:].strip()
    if remainder:
        chunks.append(remainder)
    return chunks


def phonemize(text: str) -> str:
    from vig2p import phonemize_text

    return phonemize_text(text)


def fit_to_context(chunk: str, context_length: int) -> list[str]:
    """Cắt tiếp một mảnh cho tới khi vừa cửa sổ phoneme của model.

    Model chỉ nhận context_length phoneme (512), và split_text chỉ cắt ở dấu
    kết câu — phụ đề tự động của YouTube thường KHÔNG có dấu câu nào, nên một
    "câu" có thể dài cả nghìn ký tự. Trước đây ca đó ném ValueError và giết
    nguyên job, vứt toàn bộ tiền đã trả cho bước dịch. Giờ cắt tiếp ở dấu phẩy,
    rồi ở khoảng trắng, và ghép lại bằng crossfade như các câu khác.
    """

    limit = context_length - 2  # chừa hai token bao ở hai đầu
    if len(phonemize(chunk)) <= limit:
        return [chunk]

    for pattern in (r'(?<=[,;:])\s+', r'\s+'):
        parts = [p for p in re.split(pattern, chunk) if p.strip()]
        if len(parts) < 2:
            continue
        pieces: list[str] = []
        current = ''
        for part in parts:
            candidate = f'{current} {part}'.strip()
            if current and len(phonemize(candidate)) > limit:
                pieces.append(current)
                current = part
            else:
                current = candidate
        if current:
            pieces.append(current)
        if all(len(phonemize(p)) <= limit for p in pieces):
            return pieces

    # Một "từ" đơn dài hơn cả cửa sổ (URL, chuỗi rác trong phụ đề): cắt thô
    # theo ký tự. Số phoneme không tỉ lệ đều với số ký tự nên phải dò thật
    # đoạn dài nhất còn vừa, thay vì ước theo tỉ lệ trung bình.
    pieces = []
    rest = chunk
    while rest:
        lo, hi, best = 1, len(rest), 1
        while lo <= hi:
            mid = (lo + hi) // 2
            if len(phonemize(rest[:mid])) <= limit:
                best, lo = mid, mid + 1
            else:
                hi = mid - 1
        pieces.append(rest[:best])
        rest = rest[best:]
    return pieces


def phonemes_to_input_ids(phonemes: str, vocab: dict[str, int], context_length: int) -> np.ndarray:
    """Phoneme -> id, kẹp giữa hai token 0 mà model chờ ở hai đầu."""

    input_ids = [vocab[p] for p in phonemes if p in vocab]
    if len(input_ids) + 2 > context_length:
        raise ValueError(f"chuỗi phoneme quá dài: {len(input_ids) + 2} > {context_length}")
    return np.asarray([[0, *input_ids, 0]], dtype=np.int64)


def select_voice_style(voicepack: np.ndarray, phoneme_count: int) -> np.ndarray:
    """Voicepack có một style vector cho mỗi độ dài câu; chọn theo số phoneme."""

    if phoneme_count <= 0:
        raise ValueError("phoneme_count phải lớn hơn 0")
    index = min(phoneme_count, voicepack.shape[0]) - 1
    return np.asarray(voicepack[index], dtype=np.float32)


def merge_audio_chunks(chunks: list[np.ndarray], crossfade_samples: int) -> np.ndarray:
    """Nối các câu, chồng mép bằng crossfade tuyến tính cho khỏi nghe cụp."""

    valid = [np.asarray(c, dtype=np.float32) for c in chunks if len(c) > 0]
    if not valid:
        return np.array([], dtype=np.float32)

    merged = valid[0]
    for chunk in valid[1:]:
        overlap = min(int(crossfade_samples), len(merged), len(chunk))
        if overlap <= 0:
            merged = np.concatenate([merged, chunk])
            continue
        fade_out = np.linspace(1.0, 0.0, overlap + 2, dtype=np.float32)[1:-1]
        fade_in = 1.0 - fade_out
        crossfaded = (merged[-overlap:] * fade_out) + (chunk[:overlap] * fade_in)
        merged = np.concatenate([merged[:-overlap], crossfaded, chunk[overlap:]])
    return merged.astype(np.float32, copy=False)


def _session_options() -> ort.SessionOptions:
    options = ort.SessionOptions()
    # Trong container bị giới hạn CPU, onnxruntime vẫn đếm số core của host và
    # sinh thừa thread — đặt ORT_THREADS bằng số core thực được cấp.
    threads = os.environ.get("ORT_THREADS", "").strip()
    if threads.isdigit() and int(threads) > 0:
        options.intra_op_num_threads = int(threads)
        options.inter_op_num_threads = 1
    return options


class KokoroOnnx:
    """Một ONNX session dùng chung, voicepack nạp theo yêu cầu rồi giữ lại."""

    sample_rate = SAMPLE_RATE

    def __init__(self, *, revision: str, voice: str = DEFAULT_VOICE) -> None:
        if voice not in VOICES:
            raise ValueError(f"voice {voice!r} không có. Có: {', '.join(sorted(VOICES))}")
        self.revision = revision
        self.default_voice = voice

        model_path = hf_hub_download(repo_id=REPO_ID, filename=ONNX_FILE, revision=revision)
        config_path = hf_hub_download(repo_id=REPO_ID, filename=CONFIG_FILE, revision=revision)
        self.config: dict[str, Any] = json.loads(Path(config_path).read_text(encoding="utf-8"))
        self.context_length = self.config["plbert"]["max_position_embeddings"]
        self.session = ort.InferenceSession(
            model_path, sess_options=_session_options(), providers=["CPUExecutionProvider"]
        )
        self._voicepacks: dict[str, np.ndarray] = {}
        # Chỉ khoá lúc nạp voicepack (tải file + giải nén). session.run của
        # onnxruntime an toàn khi gọi từ nhiều luồng, và synthesize không sửa
        # state nào của object, nên phần chạy model cố tình không khoá.
        self._voice_lock = threading.Lock()
        self.load_voice(voice)

    @property
    def providers(self) -> list[str]:
        return self.session.get_providers()

    def load_voice(self, voice: str) -> np.ndarray:
        cached = self._voicepacks.get(voice)
        if cached is not None:
            return cached
        if voice not in VOICES:
            raise ValueError(f"voice {voice!r} không có. Có: {', '.join(sorted(VOICES))}")
        with self._voice_lock:
            cached = self._voicepacks.get(voice)
            if cached is not None:
                return cached  # luồng khác vừa nạp xong
            path = hf_hub_download(
                repo_id=REPO_ID, filename=VOICES[voice]["filename"], revision=self.revision
            )
            voicepack = load_voicepack(path)
            self._voicepacks[voice] = voicepack
            return voicepack

    def synthesize(
        self,
        text: str,
        *,
        voice: str | None = None,
        speed: float = 1.0,
        crossfade_ms: int = DEFAULT_CROSSFADE_MS,
    ) -> np.ndarray:
        if speed <= 0:
            raise ValueError("speed phải lớn hơn 0")
        voicepack = self.load_voice(voice or self.default_voice)
        speed_value = np.asarray(float(speed), dtype=np.float32)
        vocab = self.config["vocab"]

        audio_chunks: list[np.ndarray] = []
        for sentence in split_text(text):
            for chunk in fit_to_context(sentence, self.context_length):
                phonemes = phonemize(chunk)
                if not phonemes:
                    continue
                waveform, _duration = self.session.run(
                    None,
                    {
                        "input_ids": phonemes_to_input_ids(phonemes, vocab, self.context_length),
                        "ref_s": select_voice_style(voicepack, len(phonemes)),
                        "speed": speed_value,
                    },
                )
                audio_chunks.append(np.asarray(waveform, dtype=np.float32).reshape(-1))

        return merge_audio_chunks(audio_chunks, round(SAMPLE_RATE * int(crossfade_ms) / 1000))
