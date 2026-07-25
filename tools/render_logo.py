"""Rasteriza el logo ApolAI (mismo trazado que assets/img/apolai-logo.svg) a PNG."""
from PIL import Image, ImageDraw

OUTLINE = (109, 40, 217, 255)   # #6D28D9
PANEL   = (139, 92, 246, 255)   # #8B5CF6
LIGHT   = (238, 242, 255, 255)  # #EEF2FF

SS = 8  # supersampling


def render(size, bg=None):
    n = size * SS
    k = n / 128.0
    img = Image.new("RGBA", (n, n), bg or (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def P(x, y):
        return (x * k, y * k)

    def cap(x, y, r, color):
        d.ellipse([(x - r) * k, (y - r) * k, (x + r) * k, (y + r) * k], fill=color)

    def stroke(pts, w, color):
        # segmento a segmento + tapa redonda en cada vértice: evita el "abanico"
        # que PIL genera con joint="curve" en curvas cerradas
        px = int(round(w * k))
        for a, b in zip(pts, pts[1:]):
            d.line([P(*a), P(*b)], fill=color, width=px)
        for x, y in pts:
            cap(x, y, w / 2.0, color)

    def quad(p0, p1, p2, steps=48):
        out = []
        for i in range(steps + 1):
            t = i / steps
            u = 1 - t
            out.append((u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                        u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]))
        return out

    def rrect(x, y, w, h, r, fill, outline, ow):
        d.rounded_rectangle([P(x, y), P(x + w, y + h)], radius=r * k,
                            fill=fill, outline=outline, width=int(round(ow * k)))

    # Antenas
    stroke([(45, 34), (35, 15)], 8, OUTLINE)
    stroke([(83, 34), (93, 15)], 8, OUTLINE)
    cap(35, 13, 7.5, OUTLINE)
    cap(93, 13, 7.5, OUTLINE)
    # Punto lateral izquierdo
    cap(9, 68, 6, OUTLINE)
    # Cabeza
    rrect(18, 30, 92, 76, 26, LIGHT, OUTLINE, 8)
    # Panel facial
    rrect(32, 48, 64, 40, 20, PANEL, OUTLINE, 6)
    # Ojo abierto
    cap(50, 64, 6, LIGHT)
    # Guiño
    stroke([(72, 61), (84, 67)], 6, LIGHT)
    # Boca
    stroke(quad((55, 75), (64, 84), (74, 75)), 6, LIGHT)

    return img.resize((size, size), Image.LANCZOS)


targets = [
    ("assets/img/favicon-32.png", 32, None),
    ("assets/img/favicon-192.png", 192, None),
    ("assets/img/favicon-512.png", 512, None),
    ("assets/img/apple-touch-icon.png", 180, (238, 242, 255, 255)),
]
for path, size, bg in targets:
    render(size, bg).save(path)
    print("->", path, size)
