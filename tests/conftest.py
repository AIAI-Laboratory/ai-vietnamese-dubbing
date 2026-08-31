"""Cho phép test import module trong server/ mà không đặt file test cạnh mã nguồn.

Chạy: python -m unittest discover -s tests -t tests
"""

import os
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(SERVER))

# auth.py đọc API_KEY lúc import và sys.exit nếu rỗng.
os.environ.setdefault("API_KEY", "test-key")
