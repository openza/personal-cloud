"""Regenerate the installed-app PNG icons from the Openza mark in public/favicon.svg.

Usage: python3 scripts/generate-pwa-icons.py  (requires Pillow)
"""
from pathlib import Path
from PIL import Image, ImageDraw

BACKGROUND = (23, 33, 27, 255)  # #17211b, as in favicon.svg
MARK = (255, 255, 255, 255)
OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
SCALE = 4  # supersample, then downscale for smooth edges


def draw(size, *, corner, mark_ratio):
    big = size * SCALE
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    paint = ImageDraw.Draw(image)
    if corner:
        paint.rounded_rectangle((0, 0, big - 1, big - 1), radius=round(big * corner), fill=BACKGROUND)
    else:
        paint.rectangle((0, 0, big - 1, big - 1), fill=BACKGROUND)
    # favicon.svg ring: outer 34x32 and inner 17x16 units on a 64-unit square.
    unit = big * mark_ratio / 34
    cx = cy = big / 2
    paint.ellipse((cx - 17 * unit, cy - 16 * unit, cx + 17 * unit, cy + 16 * unit), fill=MARK)
    paint.ellipse((cx - 8.5 * unit, cy - 8 * unit, cx + 8.5 * unit, cy + 8 * unit), fill=BACKGROUND)
    return image.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    draw(192, corner=18 / 64, mark_ratio=34 / 64).save(OUT / "app-192.png", optimize=True)
    draw(512, corner=18 / 64, mark_ratio=34 / 64).save(OUT / "app-512.png", optimize=True)
    # Maskable and Apple icons are full-bleed; the platform applies its own shape.
    draw(512, corner=0, mark_ratio=0.42).save(OUT / "app-maskable-512.png", optimize=True)
    draw(180, corner=0, mark_ratio=0.5).convert("RGB").save(OUT / "apple-touch-icon.png", optimize=True)


if __name__ == "__main__":
    main()
