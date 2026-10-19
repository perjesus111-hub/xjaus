import unittest
from pathlib import Path
from PIL import Image, ImageOps, ImageChops
ROOT = Path(__file__).resolve().parents[1]

class IconAssets(unittest.TestCase):
    def test_all_tauri_pngs_derive_from_cropped_source(self):
        source = Image.open(ROOT / 'resources/icon_source.png').convert('RGBA')
        for path in (ROOT / 'src-tauri/icons').glob('*.png'):
            with self.subTest(path=path.name):
                actual = Image.open(path).convert('RGBA')
                expected = ImageOps.contain(source, actual.size, Image.Resampling.LANCZOS)
                self.assertEqual(actual.size, expected.size)
                self.assertIsNone(ImageChops.difference(actual, expected).getbbox())
    def test_cropped_badge_transparent_corners_and_complete_interior(self):
        source = Image.open(ROOT / 'resources/icon_source.png').convert('RGBA')
        original = Image.open(ROOT / 'resources/icon_original.png').convert('RGBA').crop((136,136,1912,1912))
        self.assertEqual(source.size, (1776,1776))
        self.assertEqual(source.getpixel((0,0))[3], 0)
        self.assertEqual(source.getpixel((1775,1775))[3], 0)
        self.assertEqual(source.getpixel((888,888))[3], 255)
        self.assertIsNone(ImageChops.difference(source.convert('RGB'),original.convert('RGB')).getbbox())

if __name__ == '__main__':
    unittest.main()
