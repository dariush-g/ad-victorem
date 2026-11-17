"""Run the game's pixel look (src/post.ts) over a picture, for menu art.

Usage: python3 scripts/pixelate.py <input image> <output.png>

Same steps as the post shader: render small (PIXEL_HEIGHT tall, nearest), filmic tone curve,
saturation, vignette, then 4x4 ordered dither and snap to the fixed palette. A photo has no
depth, so the shader's silhouette light and shadow is left out. Keep PALETTE and the numbers
below in step with src/post.ts.
"""
import sys

import numpy as np
from PIL import Image

PIXEL_HEIGHT = 540
SATURATION, VIGNETTE, PAL_DITHER = 1.12, 0.3, 0.09
PALETTE = [
    0x0c0a0e, 0x1a1218, 0x2e1d24, 0x4a2c2e, 0x3a3352, 0x5b4f7a, 0x8f88d2,
    0x6b3f26, 0x8e5631, 0xa9683a, 0xc4864a,
    0x5a3018, 0x8a4a1e, 0xb0602a, 0xd07a34,
    0x9c7a52, 0xb08a5c, 0xdcab6c, 0xe0c392, 0xf0d19a, 0xf6e6c4, 0xfff6e0,
    0x5e1c1e, 0x9a2e2a, 0xc0342e,
    0xc08a3e, 0xecb23a, 0xff9244, 0xffb648,
    0x4c4856, 0x7a7886, 0xc4c7cf,
    0x8a5640, 0xb57b5a, 0xd9a07c,
]
BAYER = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]], dtype=np.float32) / 16 - 0.5


def main(src: str, dst: str) -> None:
    img = Image.open(src).convert('RGB')
    w = round(img.width * PIXEL_HEIGHT / img.height)
    small = img.resize((w, PIXEL_HEIGHT), Image.Resampling.BOX)  # area average, like rendering at low res
    c = (np.asarray(small, dtype=np.float32) / 255) ** 2.2  # to linear light, which the shader works in

    c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14)  # filmic curve
    luma = c @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    c = luma[..., None] + (c - luma[..., None]) * SATURATION
    ys, xs = np.mgrid[0:PIXEL_HEIGHT, 0:w].astype(np.float32)
    d = np.hypot((xs + 0.5) / w - 0.5, (ys + 0.5) / PIXEL_HEIGHT - 0.5)
    t = np.clip((d - 0.25) / 0.6, 0, 1)
    c *= (1 - VIGNETTE * t * t * (3 - 2 * t))[..., None]

    g = np.maximum(c, 0) ** (1 / 2.2)  # display space, where the palette lives
    # the shader's pixel rows count up from the bottom of the screen
    g = np.clip(g + BAYER[(PIXEL_HEIGHT - 1 - ys.astype(int)) % 4, xs.astype(int) % 4][..., None] * PAL_DITHER, 0, 1)

    pal = np.array([[(h >> 16) & 255, (h >> 8) & 255, h & 255] for h in PALETTE], dtype=np.float32) / 255
    e = g[..., None, :] - pal  # every pixel against every palette colour
    dl = e @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    dist = (e * e).sum(-1) + 2 * dl * dl
    out = pal[dist.argmin(-1)]
    Image.fromarray((out * 255 + 0.5).astype(np.uint8)).save(dst, optimize=True)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
