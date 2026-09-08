"""Extract local pond art from the two supplied flattened designs.

Usage: python scripts/prepare-koi-art.py DAY_DESIGN NIGHT_DESIGN OUTPUT_DIRECTORY
Requires Pillow, NumPy and OpenCV only when rebuilding the artwork, not at runtime.
No model or remote service is used. Obscured UI regions are reconstructed with
nearby garden texture; the original unobscured painting stays unchanged.
"""
import argparse
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


def patch(image, box, donor):
    x, y, w, h = box
    sx, sy = donor
    texture = image[sy:sy + h, sx:sx + w].copy()
    texture = cv2.flip(texture, 1)
    mask = np.full((h, w), 255, np.uint8)
    mask[[0, -1], :] = 0
    mask[:, [0, -1]] = 0
    # Feather the texture boundary to avoid a rectangular seam through the leaves.
    # seamlessClone modifies its mask, so calculate coverage before calling it.
    alpha = np.clip(cv2.distanceTransform(mask, cv2.DIST_L2, 3) / 12, 0, 1)[..., None]
    cloned = cv2.seamlessClone(texture, image, mask, (x + w // 2, y + h // 2), cv2.NORMAL_CLONE)
    image[y:y + h, x:x + w] = (
        cloned[y:y + h, x:x + w] * alpha + image[y:y + h, x:x + w] * (1 - alpha)
    ).astype(np.uint8)
    return image


def extract(path, output, night):
    # Both designs share the same composition and essentially the same aspect ratio.
    image = np.array(Image.open(path).convert("RGB").resize((1723, 913), Image.Resampling.LANCZOS))
    # Reconstruct the panel's hidden bank, rather than leave fake text in zen mode.
    image = patch(image, (1420, 120, 286, 465), (12, 200))
    image = patch(image, (10, 10, 370, 125), (18, 238))
    image = patch(image, (1598, 38, 106, 64), (1455, 22))
    image = patch(image, (24, 778, 270, 98), (24, 285))
    image = patch(image, (292, 806, 260, 55), (150, 660))
    # The lower-right legend sits on a quiet dark wash, not a detailed flower bed.
    mask = np.zeros(image.shape[:2], np.uint8)
    mask[830:852, 1480:1695] = 255
    mask[860:868, 1470:1698] = 255
    mask[851:877, 1670:1698] = 255
    image = cv2.inpaint(image, mask, 5, cv2.INPAINT_TELEA)
    Image.fromarray(image).save(output / f"koi-pond-{'night' if night else 'day'}.webp", quality=96, method=6)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("day", type=Path)
    parser.add_argument("night", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    extract(args.day, args.output, False)
    extract(args.night, args.output, True)
