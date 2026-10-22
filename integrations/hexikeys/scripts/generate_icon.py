from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "hexikeys.ico"
POINTS = ((96.6,183.4),(164.3,202.9),(82,191.9),(171.1,149.2),(168.4,56.8),(78.4,90.9),(93.6,57.1),(101.3,114.8),(47.6,127.2),(160.3,152.2),(210.3,128.8))
EDGES = ((0,1),(0,2),(0,9),(0,7),(0,8),(1,2),(1,9),(1,10),(1,3),(2,3),(2,5),(2,8),(3,9),(3,10),(3,4),(4,5),(4,9),(4,10),(4,6),(5,6),(5,7),(5,8),(6,7),(6,8),(7,8),(7,9),(8,9),(9,10),(3,5),(4,7))
COLORS = ((115,245,224,255),(241,244,255,255),(139,124,255,255),(255,202,122,255))


def main():
    scale = 3
    size = 256
    points = [((x - 38) * size / 180 * scale + 10 * scale, (y - 38) * size / 180 * scale + 10 * scale) for x, y in POINTS]
    canvas_size = size * scale
    glow = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    line = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    line_draw = ImageDraw.Draw(line)
    for index, (a, b) in enumerate(EDGES):
        color = COLORS[index % len(COLORS)]
        glow_draw.line((points[a], points[b]), fill=(color[0], color[1], color[2], 110), width=15 * scale)
        line_draw.line((points[a], points[b]), fill=color, width=3 * scale)
    glow = glow.filter(ImageFilter.GaussianBlur(12 * scale))
    image = Image.alpha_composite(glow, line)
    draw = ImageDraw.Draw(image)
    for index, (x, y) in enumerate(points):
        radius = (5 if index in (0, 1, 4, 6) else 4) * scale
        draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=COLORS[index % len(COLORS)], outline=(231,255,251,255), width=scale)
    image = image.resize((size, size), Image.Resampling.LANCZOS)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    image.save(OUT, format="ICO", sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
    print(OUT)


if __name__ == "__main__":
    main()
