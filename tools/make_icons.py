#!/usr/bin/env python3
"""Генерация иконок расширения (конверт на синем фоне + красная точка-уведомление)."""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'img')
os.makedirs(OUT, exist_ok=True)

S = 512  # рисуем крупно, потом уменьшаем


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make_base():
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

    # Градиентный фон (фирменный синий mail.ru -> голубой)
    top, bottom = (0, 95, 249), (0, 162, 255)
    grad = Image.new('RGBA', (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        gd.line([(0, y), (S, y)], fill=lerp(top, bottom, y / (S - 1)) + (255,))

    # Маска со скруглёнными углами
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)

    # Конверт
    ex0, ey0, ex1, ey1 = 88, 172, 424, 376
    d.rounded_rectangle([ex0, ey0, ex1, ey1], radius=28, fill=(255, 255, 255, 255))
    # Клапан конверта (галочка)
    flap_color = (10, 92, 235, 255)
    d.line([(ex0 + 22, ey0 + 20), (S / 2, ey0 + 118), (ex1 - 22, ey0 + 20)],
           fill=flap_color, width=26, joint='curve')
    # Нижние складки
    d.line([(ex0 + 22, ey1 - 20), (S / 2 - 60, ey1 - 78)], fill=(214, 228, 255, 255), width=16)
    d.line([(ex1 - 22, ey1 - 20), (S / 2 + 60, ey1 - 78)], fill=(214, 228, 255, 255), width=16)

    # Красная точка уведомления
    cx, cy, r = int(S * 0.76), int(S * 0.22), int(S * 0.115)
    d.ellipse([cx - r - 14, cy - r - 14, cx + r + 14, cy + r + 14], fill=(255, 255, 255, 255))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 59, 48, 255))

    return img


def main():
    base = make_base()
    for size in (16, 32, 48, 128):
        out = base.resize((size, size), Image.LANCZOS)
        path = os.path.join(OUT, f'icon{size}.png')
        out.save(path)
        print('saved', path)


if __name__ == '__main__':
    main()
