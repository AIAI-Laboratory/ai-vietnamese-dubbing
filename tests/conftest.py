"""Cho phép test import module trong server/ mà không đặt file test cạnh mã nguồn."""

import os
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(SERVER))

os.environ.setdefault("API_KEY", "test-key")
