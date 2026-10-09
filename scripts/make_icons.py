"""App icons from icons/logo.png (the guitar-pick logo, 1024 px).

    python scripts/make_icons.py

Writes icon-192/512 (any purpose), icon-maskable-512 (logo shrunk into the
safe circle Android masks to), apple-touch-icon (180) and favicon-32.
"""
import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = os.path.join(ROOT, 'icons')


def main():
    src = Image.open(os.path.join(ICONS, 'logo.png')).convert('RGB')
    bg = src.getpixel((4, 4))
    out = {
        'icon-192.png': src.resize((192, 192), Image.LANCZOS),
        'icon-512.png': src.resize((512, 512), Image.LANCZOS),
        'apple-touch-icon.png': src.resize((180, 180), Image.LANCZOS),
        'favicon-32.png': src.crop((150, 110, 874, 834)).resize((32, 32), Image.LANCZOS),
    }
    mask = Image.new('RGB', (512, 512), bg)
    inner = src.resize((410, 410), Image.LANCZOS)
    mask.paste(inner, (51, 51))
    out['icon-maskable-512.png'] = mask
    for name, im in out.items():
        im.save(os.path.join(ICONS, name), optimize=True)
        print(name, os.path.getsize(os.path.join(ICONS, name)), 'bytes')


if __name__ == '__main__':
    main()
