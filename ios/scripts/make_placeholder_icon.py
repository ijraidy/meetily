#!/usr/bin/env python3
"""Write a solid-colour 1024x1024 PNG app icon if the target file does not exist.

Uses only the Python standard library (zlib + struct), so it runs on a bare
GitHub Actions macOS runner. App Store uploads are rejected without a 1024px
icon, so the fastlane `beta` lane calls this before archiving. Replace the
generated file with a real icon whenever one is available.
"""
import struct
import sys
import zlib
from pathlib import Path

SIZE = 1024
COLOUR = (24, 30, 46)  # dark slate, matches the dark default appearance


def _chunk(tag: bytes, payload: bytes) -> bytes:
    body = tag + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def write_png(path: Path) -> None:
    row = b"\x00" + bytes(COLOUR) * SIZE
    raw = row * SIZE
    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 2, 0, 0, 0)
    data = (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(raw, 9))
        + _chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: make_placeholder_icon.py <output.png>", file=sys.stderr)
        return 2
    target = Path(sys.argv[1])
    if target.exists():
        print(f"icon already present: {target}")
        return 0
    write_png(target)
    print(f"wrote placeholder icon: {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
