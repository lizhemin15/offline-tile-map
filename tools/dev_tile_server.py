#!/usr/bin/env python3
"""本地 XYZ 瓦片服务：完全离线地开发和验证地图页面。

生成的瓦片带 z/x/y 编号和该瓦片中心点的经纬度，只是测试图案，不是真实地理数据。
默认端口 12345，路径与常见内网服务保持一致：

    http://127.0.0.1:12345/map/gsm/{z}/{x}/{y}.jpg

用法：
    python3 tools/dev_tile_server.py                     # 启动服务
    python3 tools/dev_tile_server.py --port 8081         # 换端口
    python3 tools/dev_tile_server.py --emit demo/tiles --emit-max-zoom 3
                                                         # 导出静态演示瓦片
统计接口：
    curl http://127.0.0.1:12345/__stats
    curl http://127.0.0.1:12345/__reset
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import re
import sys
import threading
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from PIL import Image, ImageDraw, ImageFont

TILE_SIZE = 256
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 每个缩放级别换一种低饱和底色，便于区分层级
PALETTE = [
    (22, 63, 84),
    (25, 74, 88),
    (28, 66, 104),
    (45, 62, 108),
    (66, 60, 104),
    (30, 78, 96),
    (34, 82, 76),
    (50, 70, 100),
]

TILE_PATH = re.compile(r"^/(?:map/gsm|tiles)/(\d{1,2})/(\d+)/(\d+)\.(?:jpg|jpeg|png)$", re.IGNORECASE)

_cache: dict[tuple[int, int, int], bytes] = {}
_cache_lock = threading.Lock()
CACHE_MAX = 512

_stats_lock = threading.Lock()
_stats = {"total": 0, "byZoom": {}, "notFound": 0, "other": 0}


@lru_cache(maxsize=32)
def _font(size: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def tile_center(z: int, x: int, y: int) -> tuple[float, float]:
    n = 2 ** z
    lon = (x + 0.5) / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 0.5) / n))))
    return lon, lat


def _mix(color: tuple[int, int, int], other: tuple[int, int, int], ratio: float) -> tuple[int, int, int]:
    return tuple(int(round(a + (b - a) * ratio)) for a, b in zip(color, other))


def render_tile(z: int, x: int, y: int, quality: int = 82) -> bytes:
    base = PALETTE[z % len(PALETTE)]
    alt = (x + y) % 2 == 0
    if alt:
        base = _mix(base, (255, 255, 255), 0.035)

    img = Image.new("RGB", (TILE_SIZE, TILE_SIZE), base)
    draw = ImageDraw.Draw(img)

    grid = _mix(base, (255, 255, 255), 0.10)
    edge = _mix(base, (255, 255, 255), 0.22)

    # 4×4 辅助网格
    for i in range(1, 4):
        pos = i * TILE_SIZE // 4
        draw.line([(pos, 0), (pos, TILE_SIZE)], fill=grid, width=1)
        draw.line([(0, pos), (TILE_SIZE, pos)], fill=grid, width=1)

    # 瓦片边界与四角刻度，方便观察拼接
    draw.rectangle([0, 0, TILE_SIZE - 1, TILE_SIZE - 1], outline=edge, width=1)
    for corner in ((0, 0), (TILE_SIZE - 1, 0), (0, TILE_SIZE - 1), (TILE_SIZE - 1, TILE_SIZE - 1)):
        cx, cy = corner
        sx = 1 if cx == 0 else -1
        sy = 1 if cy == 0 else -1
        draw.line([(cx, cy), (cx + 18 * sx, cy)], fill=edge, width=2)
        draw.line([(cx, cy), (cx, cy + 18 * sy)], fill=edge, width=2)

    # 中心十字
    faint = _mix(base, (255, 255, 255), 0.16)
    draw.line([(TILE_SIZE // 2, 96), (TILE_SIZE // 2, 160)], fill=faint, width=1)
    draw.line([(96, TILE_SIZE // 2), (160, TILE_SIZE // 2)], fill=faint, width=1)

    white = (242, 248, 255)
    soft = _mix(base, (255, 255, 255), 0.62)

    f_small = _font(13, bold=True)
    f_zoom = _font(64, bold=True)
    f_xy = _font(34, bold=True)
    f_meta = _font(12, bold=False)

    draw.text((12, 10), "OFFLINE DEMO", font=f_small, fill=soft)
    draw.text((TILE_SIZE - 12, 10), "256px", font=f_meta, fill=soft, anchor="ra")

    zoom_text = f"z{z}"
    draw.text((TILE_SIZE // 2, TILE_SIZE // 2 - 34), zoom_text, font=f_zoom, fill=white, anchor="mm")
    draw.text((TILE_SIZE // 2, TILE_SIZE // 2 + 26), f"{x} / {y}", font=f_xy, fill=white, anchor="mm")

    lon, lat = tile_center(z, x, y)
    draw.text(
        (TILE_SIZE // 2, TILE_SIZE - 14),
        f"lon {lon:.3f}  lat {lat:.3f}",
        font=f_meta,
        fill=soft,
        anchor="ms",
    )

    out = io.BytesIO()
    img.save(out, format="JPEG", quality=quality, optimize=True)
    return out.getvalue()


def cached_tile(z: int, x: int, y: int, quality: int) -> bytes:
    key = (z, x, y)
    with _cache_lock:
        data = _cache.get(key)
    if data is not None:
        return data
    data = render_tile(z, x, y, quality)
    with _cache_lock:
        if len(_cache) >= CACHE_MAX:
            _cache.clear()
        _cache[key] = data
    return data


def tile_exists(z: int, x: int, y: int) -> bool:
    if z < 0 or z > 22:
        return False
    n = 2 ** z
    return 0 <= x < n and 0 <= y < n


def emit_tiles(directory: str, max_zoom: int, quality: int) -> int:
    count = 0
    for z in range(max_zoom + 1):
        n = 2 ** z
        for x in range(n):
            folder = os.path.join(directory, str(z), str(x))
            os.makedirs(folder, exist_ok=True)
            for y in range(n):
                path = os.path.join(folder, f"{y}.jpg")
                with open(path, "wb") as handle:
                    handle.write(render_tile(z, x, y, quality))
                count += 1
    return count


class TileHandler(BaseHTTPRequestHandler):
    server_version = "OfflineDemoTiles/1.0"
    quality = 82
    verbose = False

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        if self.verbose:
            sys.stderr.write("[tiles] " + (fmt % args) + "\n")

    def _send(self, status: int, body: bytes, content_type: str, cache: str = "no-store") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("X-Tile-Server", "offline-demo")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path

        if path in ("/", "/index.html"):
            self._send(200, self._index_html().encode("utf-8"), "text/html; charset=utf-8")
            return

        if path == "/__stats":
            with _stats_lock:
                body = json.dumps(_stats, ensure_ascii=False).encode("utf-8")
            self._send(200, body, "application/json; charset=utf-8")
            return

        if path == "/__reset":
            with _stats_lock:
                _stats.update({"total": 0, "byZoom": {}, "notFound": 0, "other": 0})
            with _cache_lock:
                _cache.clear()
            self._send(200, b'{"ok":true}', "application/json; charset=utf-8")
            return

        match = TILE_PATH.match(path)
        if not match:
            with _stats_lock:
                _stats["other"] += 1
            self._send(404, b"Not Found\n", "text/plain; charset=utf-8")
            return

        z, x, y = (int(match.group(1)), int(match.group(2)), int(match.group(3)))
        with _stats_lock:
            if tile_exists(z, x, y):
                _stats["total"] += 1
                key = str(z)
                _stats["byZoom"][key] = _stats["byZoom"].get(key, 0) + 1
            else:
                _stats["notFound"] += 1

        if not tile_exists(z, x, y):
            self._send(404, b"Tile out of range\n", "text/plain; charset=utf-8")
            return

        body = cached_tile(z, x, y, self.quality)
        self._send(200, body, "image/jpeg", cache="public, max-age=3600")

    def _index_html(self) -> str:
        host = self.headers.get("Host") or f"127.0.0.1:{self.server.server_port}"
        return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>本地测试瓦片服务</title>
<style>body{{font:14px/1.7 system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 20px;color:#0f172a}}
code{{background:#f1f5f9;padding:2px 6px;border-radius:4px}} a{{color:#0369a1}}
img{{width:128px;border:1px solid #cbd5e1;border-radius:6px;vertical-align:middle}}</style></head>
<body>
<h1>本地测试瓦片服务</h1>
<p>这是给 <code>offline-tile-map</code> 联调用的合成瓦片，不是真实地理数据。</p>
<p>瓦片地址：<code>http://{host}/map/gsm/{{z}}/{{x}}/{{y}}.jpg</code></p>
<p>打开地图：<code>http://127.0.0.1:8080/?tile=http://{host}/map/gsm/{{z}}/{{x}}/{{y}}.jpg&amp;maxZoom=11&amp;maxNativeZoom=11</code></p>
<p>示例 <img src="/map/gsm/3/6/3.jpg" alt="sample tile"></p>
<p>统计：<a href="/__stats">/__stats</a> · 重置：<a href="/__reset">/__reset</a></p>
</body></html>"""


def main() -> int:
    parser = argparse.ArgumentParser(description="离线 XYZ 测试瓦片服务")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址，默认 0.0.0.0")
    parser.add_argument("--port", type=int, default=12345, help="监听端口，默认 12345")
    parser.add_argument("--quality", type=int, default=82, help="JPEG 质量，默认 82")
    parser.add_argument("--verbose", action="store_true", help="打印每个瓦片请求")
    parser.add_argument("--emit", metavar="DIR", help="导出静态瓦片到目录后退出")
    parser.add_argument("--emit-max-zoom", type=int, default=3, help="导出瓦片的最大级别，默认 3")
    args = parser.parse_args()

    if args.emit:
        count = emit_tiles(args.emit, args.emit_max_zoom, args.quality)
        print(f"已导出 {count} 张瓦片（z0 - z{args.emit_max_zoom}）到 {args.emit}")
        return 0

    TileHandler.quality = args.quality
    TileHandler.verbose = args.verbose

    server = ThreadingHTTPServer((args.host, args.port), TileHandler)
    server.daemon_threads = True
    print(f"测试瓦片服务已启动: http://127.0.0.1:{args.port}/map/gsm/{{z}}/{{x}}/{{y}}.jpg")
    print(f"统计接口: http://127.0.0.1:{args.port}/__stats")
    print("Ctrl+C 退出")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
