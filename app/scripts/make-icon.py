# Draws the site icon: a pixel robot head in the game's neon palette (SVG + PNGs, no dependencies).
# Run: python3 scripts/make-icon.py  → public/favicon.svg, favicon-32.png, apple-touch-icon.png
import struct, zlib, os

ART = [
    "................",
    ".......YY.......",
    "........m.......",
    "...MMMMMMMMMM...",
    "..MddddddddddM..",
    ".mMdCCCddCCCdMm.",
    ".mMdCwCddCwCdMm.",
    "..MdCCCddCCCdM..",
    "..MddddddddddM..",
    "..MdyyyyyyyydM..",
    "..MddddddddddM..",
    "...MMMMMMMMMM...",
    ".....mM..Mm.....",
    "...cccccccccc...",
    "..cc........cc..",
    "................",
]
PAL = {
    'M': (255, 42, 138), 'm': (170, 20, 92),   # magenta shell / shade
    'd': (20, 14, 34),                          # dark face
    'C': (0, 240, 255), 'w': (220, 255, 255),   # cyan visor eyes + glint
    'y': (255, 230, 0), 'Y': (255, 230, 0),     # heat bar, antenna tip
    'c': (0, 160, 190),                         # shoulders
}
BG = (7, 6, 12)
N = 16

def svg():
    px = []
    for y, row in enumerate(ART):
        for x, ch in enumerate(row):
            if ch in PAL:
                r, g, b = PAL[ch]
                px.append(f'<rect x="{x}" y="{y}" width="1" height="1" fill="#{r:02x}{g:02x}{b:02x}"/>')
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 18 18" shape-rendering="crispEdges">'
            '<rect x="-1" y="-1" width="18" height="18" rx="3" fill="#07060c"/>' + ''.join(px) + '</svg>\n')

def png(size, pad):
    cell = (size - 2 * pad) // N
    off = (size - cell * N) // 2
    rows = []
    for py in range(size):
        row = bytearray([0])
        for pxl in range(size):
            gx, gy = (pxl - off) // cell, (py - off) // cell
            c = BG
            if 0 <= gx < N and 0 <= gy < N and pxl >= off and py >= off and ART[gy][gx] in PAL:
                c = PAL[ART[gy][gx]]
            row += bytes(c) + b'\xff'
        rows.append(bytes(row))
    raw = zlib.compress(b''.join(rows), 9)
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', raw) + chunk(b'IEND', b'')

out = os.path.join(os.path.dirname(__file__), '..', 'public')
open(os.path.join(out, 'favicon.svg'), 'w').write(svg())
open(os.path.join(out, 'favicon-32.png'), 'wb').write(png(32, 0))
open(os.path.join(out, 'apple-touch-icon.png'), 'wb').write(png(180, 10))
print('icons written')
