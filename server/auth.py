"""Khoá TOÀN BỘ route bằng header X-API-Key — server chỉ dùng qua API (không còn UI/dashboard),
nên auth phải BẮT BUỘC, không có kiểu "để trống = không khoá" như bản có UI trước — tránh bị
lợi dụng khi public.
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
_API_KEY_BYTES = API_KEY.encode("utf-8")


async def require_api_key(key: str | None = Security(_api_key_header)) -> None:
    if not key:
        raise HTTPException(401, "thiếu hoặc sai X-API-Key")
    candidate = key.encode("utf-8", "surrogateescape")
    if not secrets.compare_digest(candidate, _API_KEY_BYTES):
        raise HTTPException(401, "thiếu hoặc sai X-API-Key")
