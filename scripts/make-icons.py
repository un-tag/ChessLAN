"""Generates the app and tray icons from the chess knight glyph.

Run with `npm run icons`; the outputs are committed. Needs Pillow and the
DejaVu Sans font (pass another font path as the first argument if needed).
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT = sys.argv[1] if len(sys.argv) > 1 else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
KNIGHT = "♞"
GREEN = (129, 182, 76, 255)
DARK = (38, 36, 33, 255)


def glyph(size: int, fill, box: float) -> Image.Image:
    """The knight glyph centred in a transparent square, filling `box` of it."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, int(size * box))
    l, t, r, b = draw.textbbox((0, 0), KNIGHT, font=font)
    draw.text(((size - (r - l)) / 2 - l, (size - (b - t)) / 2 - t), KNIGHT, font=font, fill=fill)
    return img


def app_icon(size: int) -> Image.Image:
    # macOS-style rounded square with a margin, dark tile, green knight.
    scale = 4
    big = size * scale
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    margin = int(big * 0.09)
    ImageDraw.Draw(img).rounded_rectangle(
        (margin, margin, big - margin, big - margin), radius=int(big * 0.2), fill=DARK
    )
    img.alpha_composite(glyph(big, GREEN, 0.62))
    return img.resize((size, size), Image.LANCZOS)


def tray_win(size: int) -> Image.Image:
    scale = 8
    big = size * scale
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(img).rounded_rectangle((0, 0, big - 1, big - 1), radius=int(big * 0.22), fill=GREEN)
    img.alpha_composite(glyph(big, (255, 255, 255, 255), 0.78))
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    (ROOT / "build").mkdir(exist_ok=True)
    (ROOT / "resources").mkdir(exist_ok=True)
    app_icon(1024).save(ROOT / "build" / "icon.png")
    app_icon(512).save(ROOT / "resources" / "icon.png")
    # macOS menu bar: black template image, 22pt with @2x.
    for name, px in (("trayTemplate.png", 22), ("trayTemplate@2x.png", 44)):
        glyph(px * 8, (0, 0, 0, 255), 0.9).resize((px, px), Image.LANCZOS).save(ROOT / "resources" / name)
    tray_win(32).save(ROOT / "resources" / "tray.png")
    tray_win(256).save(ROOT / "resources" / "tray.ico", sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (48, 48)])


if __name__ == "__main__":
    main()
