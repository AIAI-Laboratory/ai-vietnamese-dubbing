# Local AI Vietnamese Dubbing

Extension Chrome lồng tiếng Việt cho video Coursera và YouTube.

- Gemini dịch phụ đề.
- VieNeu-TTS v3 Nano đọc bản dịch trên CPU máy bạn.
- Audio chia theo cửa sổ timeline và phát dần.
- Bản lồng tiếng hoàn tất được lưu trong IndexedDB.

Video và audio vẫn ở trên máy. Chỉ chữ phụ đề được gửi tới Gemini.

## Thư mục chính

```text
extension/   Chrome MV3 extension
server/      FastAPI và VieNeu Nano
tests/       Test JavaScript và Python
deploy/      Ghi chú deploy server
scripts/     Công cụ tải model
```

## Yêu cầu

- Chrome 116+
- Python 3.12
- uv
- ffmpeg
- Gemini API key

Cài uv theo [hướng dẫn chính thức](https://docs.astral.sh/uv/getting-started/installation/).

## Cài đặt

Từ thư mục gốc repo:

```bash
uv sync --python 3.12
cp server/.env.example server/.env
uv run python -c "import secrets; print(secrets.token_hex(16))"
```

Đặt giá trị vừa tạo vào `server/.env`:

```env
API_KEY=your-server-key
```

Tải và kiểm tra model:

```bash
uv run python scripts/download_vieneu_model.py
```

Model nằm tại `server/models/vieneu-nano/`. Thư mục này được Git bỏ qua.
Xem thêm [MODEL_DEPLOY.md](MODEL_DEPLOY.md).

Chạy server:

```bash
uv run python server/main.py
```

Kiểm tra:

```bash
curl -H "X-API-Key: your-server-key" \
  http://127.0.0.1:18765/api/health
```

Kết quả cần có `"status":"ready"`.

Load extension:

1. Mở `chrome://extensions`.
2. Bật Developer mode.
3. Chọn **Load unpacked** và trỏ tới `extension/`.
4. Mở Options, điền Gemini key, Server URL và Server API key.
5. Bấm **Kiểm tra server** và **Tải danh sách giọng**.

## Cách dùng

1. Mở video Coursera hoặc YouTube có phụ đề tiếng Anh.
2. Bật trang tương ứng trong **Options → Trang hỗ trợ**.
3. Bấm nút thuyết minh trên video.

Cửa sổ audio đầu tiên phát ngay khi sẵn sàng. Sau khi sửa code hoặc đổi trang
hỗ trợ, hãy reload tab video.

## Cấu hình server

Các biến nằm trong `server/.env`:

| Biến | Mặc định | Công dụng |
|---|---:|---|
| `HOST` | `127.0.0.1` | Địa chỉ bind |
| `PORT` | `18765` | Cổng HTTP |
| `API_KEY` | bắt buộc | Khoá mọi API route |
| `VIENEU_VOICE` | `Adam` | Giọng mặc định |
| `VIENEU_STEPS` | `16` | Cân bằng chất lượng/tốc độ |
| `VIENEU_CFG` | `3.0` | Tham số VieNeu |
| `SYNTH_WORKERS` | `3` | Số câu chạy song song |
| `ORT_THREADS` | không đặt | Giới hạn thread ONNX |
| `JOB_RETENTION_MIN` | `60` | Thời gian giữ job xong |
| `MAX_PENDING_JOBS` | `4` | Giới hạn hàng đợi |
| `MAX_BODY_MB` | `16` | Giới hạn request body |
| `ENABLE_DOCS` | `0` | Swagger/OpenAPI |

## API

Mọi route cần header `X-API-Key`.

```text
GET    /api/health
GET    /api/voices
POST   /api/preview
POST   /api/synthesize
GET    /api/job/{job_id}
DELETE /api/job/{job_id}
GET    /audio/{job_id}/w{index}.{ext}
```

Audio dùng Opus, fallback sang MP3 nếu ffmpeg thiếu hỗ trợ Opus.

## Kiểm thử

```bash
node --test tests/*.test.js
uv run python -m unittest discover -s tests -t tests
uv pip check
```

Hiện có 50 test JavaScript và 49 test Python.

## Giới hạn

- Chỉ có adapter Coursera và YouTube.
- Timestamp transcript YouTube kém chính xác hơn WebVTT của Coursera.
- Mỗi job dùng một giọng.
- Job lưu trong RAM và mất khi server dừng.
- Máy mới phải tải model một lần.

## Giấy phép

Project dùng Apache-2.0. VieNeu-TTS v3 Nano cũng dùng Apache-2.0. Xem
[LICENSE](LICENSE).
