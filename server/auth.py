"""Khoá TOÀN BỘ route bằng header X-API-Key — server chỉ dùng qua API
(không còn UI/dashboard), nên auth phải BẮT BUỘC, không có kiểu "để trống
= không khoá" như bản có UI trước — tránh bị lợi dụng khi public.

Dùng fastapi.security.APIKeyHeader (không phải Header() thường) để Swagger
UI (/docs) tự hiện nút "Authorize" — dán key 1 lần, mọi request "Try it
out" tự gắn kèm, không phải tự thêm header tay từng lần.

Dùng secrets.compare_digest (không phải ==) để so khớp — tránh timing
attack dò ký tự đúng/sai qua thời gian phản hồi.
"""

from __future__ import annotations

import os
import secrets
import sys

from fastapi import HTTPException, Security
from fastapi.security import APIKeyHeader

API_KEY = os.environ.get("API_KEY", "").strip()

if not API_KEY:
    sys.exit(
        "LỖI: chưa đặt API_KEY trong server/.env — server này chỉ chạy qua "
        "API công khai nên BẮT BUỘC phải có key để tránh ai cũng gọi được. "
        "Sinh 1 key: python -c \"import secrets; print(secrets.token_hex(16))\" "
        "rồi dán vào API_KEY trong server/.env."
    )

_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


async def require_api_key(key: str | None = Security(_api_key_header)) -> None:
    if not key or not secrets.compare_digest(key, API_KEY):
        raise HTTPException(401, "thiếu hoặc sai X-API-Key")
