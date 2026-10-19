"""Regenerate XJAUS assets from the cropped golden badge (Pillow LANCZOS)."""
from pathlib import Path
import argparse
from PIL import Image, ImageOps, ImageDraw, ImageFilter
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, help='Convert the exact supplied image to icon_source.png')
args = parser.parse_args()
source = ROOT / 'resources/icon_source.png'
if args.source:
    with Image.open(args.source) as image:
        image = image.convert('RGBA')
        image.save(ROOT / 'resources/icon_original.png')
        rgb = np.asarray(image)[:, :, :3].astype(int)
        gold = (rgb[:, :, 0] > rgb[:, :, 2] * 1.3) & (rgb[:, :, 0] > 140) & (rgb[:, :, 1] > 100)
        points = []
        for y in range(gold.shape[0]):
            xs = np.flatnonzero(gold[y])
            if len(xs):
                points.extend([(int(xs[0]), y), (int(xs[-1]), y)])
        # Convex outer golden outline: remove exterior grey, retain all interior art.
        points = sorted(set(points))
        def cross(o, a, b):
            return (a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0])
        lower, upper = [], []
        for point in points:
            while len(lower) >= 2 and cross(lower[-2], lower[-1], point) <= 0:
                lower.pop()
            lower.append(point)
        for point in reversed(points):
            while len(upper) >= 2 and cross(upper[-2], upper[-1], point) <= 0:
                upper.pop()
            upper.append(point)
        mask = Image.new('L', image.size)
        ImageDraw.Draw(mask).polygon(lower[:-1] + upper[:-1], fill=255)
        image.putalpha(mask.filter(ImageFilter.MaxFilter(7)))
        # Original-coordinate square enclosing the complete golden badge.
        image.crop((136, 136, 1912, 1912)).save(source, format='PNG')
with Image.open(source) as image:
    image = image.convert('RGBA')
    icons = ROOT / 'resources/icons'
    tauri = ROOT / 'src-tauri/icons'
    icons.mkdir(parents=True, exist_ok=True)
    tauri.mkdir(parents=True, exist_ok=True)
    for size in (512, 256, 128, 64, 32):
        # Contain + pad preserves every pixel; never crop, even for non-square input.
        scaled = ImageOps.contain(image, (size, size), Image.Resampling.LANCZOS)
        square = Image.new('RGBA', (size, size))
        square.paste(scaled, ((size-scaled.width)//2, (size-scaled.height)//2))
        square.save(icons / f'{size}x{size}.png')
        square.save(tauri / f'{size}x{size}.png')
        if size == 256:
            square.save(tauri / '128x128@2x.png')
            square.save(ROOT / 'public/favicon.png')
    # Replace every pre-existing platform logo too, retaining its required dimensions.
    for target in [*tauri.glob('Square*Logo.png'), tauri / 'StoreLogo.png']:
        if target.exists():
            with Image.open(target) as existing:
                size = existing.size
            ImageOps.contain(image, size, Image.Resampling.LANCZOS).save(target)
    image.save(tauri / 'icon.png')
    image.save(tauri / 'icon.ico', sizes=[(s,s) for s in (16,32,48,64,128,256)], bitmap_format='png')
    image.save(tauri / 'icon.icns', sizes=[(s,s) for s in (16,32,64,128,256,512,1024)])
