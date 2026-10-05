"""favicon.ico (16, 32, 48) from the exported favicon PNGs. Needs Pillow."""
import os
from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
png = lambda px: Image.open(os.path.join(here, 'png', f'favicon-{px}.png')).convert('RGBA')
out = os.path.join(here, '..', 'client', 'public', 'favicon.ico')
png(48).save(out, sizes=[(16, 16), (32, 32), (48, 48)], append_images=[png(16), png(32)])
print('wrote', os.path.normpath(out))
