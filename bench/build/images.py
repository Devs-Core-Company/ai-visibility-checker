import os, random, sys
from PIL import Image, ImageDraw, ImageFont
out = sys.argv[1]
random.seed(7)
def mk(path, w, h, c1, c2, label, fmt='JPEG', q=70):
    p = os.path.join(out, path); os.makedirs(os.path.dirname(p), exist_ok=True)
    im = Image.new('RGB', (w, h), c1); d = ImageDraw.Draw(im)
    for y in range(h):
        t = y / max(h-1,1)
        d.line([(0,y),(w,y)], fill=tuple(int(c1[i]*(1-t)+c2[i]*t) for i in range(3)))
    for _ in range(6):
        x, y, r = random.randint(0,w), random.randint(0,h), random.randint(w//12, w//5)
        d.ellipse([x-r,y-r,x+r,y+r], outline=(255,255,255), width=3)
    d.text((20, h-40), label, fill=(255,255,255))
    if fmt == 'PNG': im.save(p, 'PNG', optimize=True)
    else: im.save(p, 'JPEG', quality=q, optimize=True)
teal=(11,95,115); sand=(232,214,180); navy=(20,40,70); mint=(150,210,200)
mk('images/hero-harbourline.jpg', 1600, 1000, teal, mint, 'Harbourline Dental Studio')
mk('images/og-default.jpg', 1200, 630, navy, teal, 'Harbourline Dental Studio')
for s in ['general-dentistry','dental-implants','teeth-whitening','invisalign','emergency-dentist','hygiene','childrens-dentistry','veneers']:
    mk(f'images/services/{s}.jpg', 1600, 1000, teal, sand, s)
for s in ['dr-amelia-hart','dr-rohan-mehta','dr-sophie-lang','tom-ellis']:
    mk(f'images/team/{s}.jpg', 600, 600, navy, sand, s)
for s in ['bristol','bath','leeds']:
    mk(f'images/locations/{s}.jpg', 1600, 1000, navy, mint, s)
for i in range(1, 13):
    mk(f'images/blog/post-{i:02d}.jpg', 1600, 900, (random.randint(10,90),random.randint(60,120),random.randint(90,140)), sand, f'article image {i}')
mk('images/logo.png', 480, 120, teal, teal, 'Harbourline', 'PNG')
fav = Image.new('RGB', (64,64), teal); ImageDraw.Draw(fav).ellipse([12,12,52,52], outline=(255,255,255), width=5)
fav.save(os.path.join(out,'favicon.png')); fav.save(os.path.join(out,'favicon.ico'), sizes=[(32,32)])
# oversized panorama ~600 KB: noisy, large
w,h = 2400, 1000
im = Image.new('RGB',(w,h)); px = im.load()
for y in range(h):
    for x in range(w):
        px[x,y] = (min(255, 40 + y//8 + random.randint(0,60)), min(255, 90 + random.randint(0,70)), min(255, 120 + x//40 % 60 + random.randint(0,40)))
q = 70
while True:
    p = os.path.join(out,'images/clinic-panorama.jpg'); im.save(p,'JPEG',quality=q)
    sz = os.path.getsize(p)
    if sz < 560_000: q += 4
    elif sz > 680_000: q -= 4
    else: break
    if q > 95 or q < 20: break
print('panorama', os.path.getsize(p), q)
