# Regenerates the vision fixtures: a washing-machine panel with the program
# dial on Cottons (verify → yes) and on Synthetics (verify → no), and a
# FABRICATED utility bill (video 2 prop — never real mail) with its exact
# text in bill.txt as ground truth. Rendered flat, then rotated onto a dark
# background so frames look closer to a camera shot than a screenshot.
#
#   python3 test/fixtures/make-fixtures.py test/fixtures      (needs Pillow)

import math, sys
from PIL import Image, ImageDraw, ImageFont
OUT = sys.argv[1]
def font(sz, bold=False):
    paths = (['/System/Library/Fonts/Supplemental/Arial Bold.ttf'] if bold else []) + [
        '/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc']
    for p in paths:
        try: return ImageFont.truetype(p, sz)
        except Exception: pass
    return ImageFont.load_default()

def photo(im, angle, bg=(58, 52, 48), size=(1280, 960)):
    # Place the flat render on a background, slightly rotated — closer to a camera frame.
    im = im.rotate(angle, expand=True, fillcolor=bg, resample=Image.BICUBIC)
    canvas = Image.new('RGB', size, bg)
    im.thumbnail((int(size[0] * 0.9), int(size[1] * 0.9)))
    canvas.paste(im, ((size[0] - im.width) // 2, (size[1] - im.height) // 2))
    return canvas

def dial(pointer, path):
    W, H = 960, 720
    im = Image.new('RGB', (W, H), (236, 236, 232)); d = ImageDraw.Draw(im)
    d.rectangle([40, 50, 920, 670], fill=(246, 246, 244), outline=(150, 150, 150), width=4)
    d.rectangle([80, 90, 330, 175], fill=(226, 226, 224), outline=(120, 120, 120), width=3)
    d.text((205, 132), 'I      II      *', anchor='mm', fill=(60, 60, 60), font=font(34))
    d.rectangle([620, 95, 860, 175], fill=(28, 38, 34)); d.text((740, 135), '40°C', anchor='mm', fill=(120, 255, 160), font=font(48))
    d.rounded_rectangle([600, 220, 730, 285], 12, fill=(212, 212, 212), outline=(120, 120, 120), width=2)
    d.text((665, 252), 'Temp', anchor='mm', font=font(28), fill=(40, 40, 40))
    d.rounded_rectangle([750, 220, 900, 285], 12, fill=(212, 212, 212), outline=(120, 120, 120), width=2)
    d.text((825, 252), 'Start/Pause', anchor='mm', font=font(22), fill=(40, 40, 40))
    cx, cy, r = 330, 450, 140
    labels = {'Cottons': 150, 'Synthetics': 90, 'Delicates': 30, 'Spin': -30, 'Rinse': 210}
    for name, ang in labels.items():
        a = math.radians(ang)
        d.line([cx + r * math.cos(a), cy - r * math.sin(a), cx + (r + 22) * math.cos(a), cy - (r + 22) * math.sin(a)], fill=(60, 60, 60), width=4)
        d.text((cx + (r + 78) * math.cos(a), cy - (r + 58) * math.sin(a)), name, anchor='mm', font=font(30), fill=(20, 20, 20))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(198, 198, 204), outline=(90, 90, 90), width=5)
    a = math.radians(labels[pointer]); px, py = cx + (r - 22) * math.cos(a), cy - (r - 22) * math.sin(a)
    d.line([cx, cy, px, py], fill=(200, 30, 30), width=16)
    d.ellipse([px - 15, py - 15, px + 15, py + 15], fill=(200, 30, 30))
    d.ellipse([cx - 32, cy - 32, cx + 32, cy + 32], fill=(118, 118, 124))
    photo(im, -4).save(path, quality=88)

BILL_LINES = [
    ('Riverside Water & Power', 46, True),
    ('PO Box 4410, Riverside, OR 97000', 24, False),
    ('', 18, False),
    ('STATEMENT', 34, True),
    ('Account number: 55-2091-7', 28, False),
    ('Statement date: September 2, 2026', 28, False),
    ('Service period: August 1 - August 31, 2026', 28, False),
    ('', 18, False),
    ('Previous balance                     $38.40', 28, False),
    ('Payment received - thank you        -$38.40', 28, False),
    ('Water usage (4,120 gallons)            $27.35', 28, False),
    ('Sewer service                             $11.62', 28, False),
    ('Taxes and fees                              $3.20', 28, False),
    ('', 18, False),
    ('AMOUNT DUE: $42.17', 44, True),
    ('DUE BY: September 30, 2026', 40, True),
    ('', 18, False),
    ('A late fee of $5.00 applies to payments received after the due date.', 22, False),
    ('Pay online, by phone at 1-800-555-0142, or by mail.', 22, False),
    ('', 18, False),
    ('SAMPLE - demo prop, not a real bill', 20, False),
]

def bill(path_img, path_txt):
    W, H = 900, 1180
    im = Image.new('RGB', (W, H), (252, 252, 250)); d = ImageDraw.Draw(im)
    y = 60
    for text, sz, bold in BILL_LINES:
        if text.startswith('AMOUNT DUE'):
            d.rectangle([50, y - 10, 850, y + 110], outline=(30, 30, 30), width=3)
        d.text((70, y), text, font=font(sz, bold), fill=(25, 25, 25))
        y += int(sz * 1.55)
    photo(im, 3, size=(1280, 1280)).save(path_img, quality=90)
    with open(path_txt, 'w') as f:
        f.write('\n'.join(t for t, _, _ in BILL_LINES if t) + '\n')

dial('Cottons', f'{OUT}/dial-cottons.jpg')
dial('Synthetics', f'{OUT}/dial-synthetics.jpg')
bill(f'{OUT}/bill.jpg', f'{OUT}/bill.txt')
print('fixtures written')
