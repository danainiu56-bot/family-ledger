#!/usr/bin/env python3
"""生成微信小程序 tabBar 图标(纯标准库，无第三方依赖)。
输出 81x81 RGBA PNG，3x 超采样抗锯齿。
  home.png / home-active.png  首页
  plan.png / plan-active.png  计划
"""
import os, zlib, struct

OUT = os.path.join(os.path.dirname(__file__), '..', 'miniprogram', 'images')
SIZE = 81
SS = 4              # 超采样倍数
S = SIZE * SS

NORMAL = (148, 163, 184)   # #94a3b8
ACTIVE = (99, 102, 241)    # #6366f1


def new_buf():
    return [0.0] * (S * S)  # 覆盖率(0..1)


def set_cov(buf, x, y, v=1.0):
    if 0 <= x < S and 0 <= y < S:
        if v > buf[y * S + x]:
            buf[y * S + x] = v


def fill_rect(buf, x0, y0, x1, y1):
    for y in range(int(y0), int(y1)):
        for x in range(int(x0), int(x1)):
            set_cov(buf, x, y)


def fill_rounded_rect(buf, x0, y0, x1, y1, r):
    for y in range(int(y0), int(y1)):
        for x in range(int(x0), int(x1)):
            cx = min(max(x, x0 + r), x1 - r)
            cy = min(max(y, y0 + r), y1 - r)
            dx = x - cx
            dy = y - cy
            if dx * dx + dy * dy <= r * r:
                set_cov(buf, x, y)


def fill_triangle(buf, p0, p1, p2):
    xs = [p0[0], p1[0], p2[0]]
    ys = [p0[1], p1[1], p2[1]]
    minx, maxx = int(min(xs)), int(max(xs)) + 1
    miny, maxy = int(min(ys)), int(max(ys)) + 1

    def sign(a, b, c):
        return (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1])

    for y in range(miny, maxy):
        for x in range(minx, maxx):
            pt = (x + 0.5, y + 0.5)
            d1 = sign(pt, p0, p1)
            d2 = sign(pt, p1, p2)
            d3 = sign(pt, p2, p0)
            neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
            pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
            if not (neg and pos):
                set_cov(buf, x, y)


def carve_rect(buf, x0, y0, x1, y1):
    for y in range(int(y0), int(y1)):
        for x in range(int(x0), int(x1)):
            if 0 <= x < S and 0 <= y < S:
                buf[y * S + x] = 0.0


def carve_rounded_rect(buf, x0, y0, x1, y1, r):
    for y in range(int(y0), int(y1)):
        for x in range(int(x0), int(x1)):
            cx = min(max(x, x0 + r), x1 - r)
            cy = min(max(y, y0 + r), y1 - r)
            if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                if 0 <= x < S and 0 <= y < S:
                    buf[y * S + x] = 0.0


def home_buf():
    buf = new_buf()
    # 屋顶三角
    apex = (0.5 * S, 0.13 * S)
    left = (0.10 * S, 0.50 * S)
    right = (0.90 * S, 0.50 * S)
    fill_triangle(buf, apex, left, right)
    # 房体
    fill_rect(buf, 0.22 * S, 0.46 * S, 0.78 * S, 0.88 * S)
    # 门(挖空)
    carve_rounded_rect(buf, 0.42 * S, 0.62 * S, 0.58 * S, 0.89 * S, 0.07 * S)
    return buf


def plan_buf():
    buf = new_buf()
    # 文档页面
    fill_rounded_rect(buf, 0.24 * S, 0.12 * S, 0.76 * S, 0.88 * S, 0.07 * S)
    # 文本行(挖空)
    for fy in (0.30, 0.45, 0.60):
        carve_rounded_rect(buf, 0.34 * S, fy * S, 0.66 * S, (fy + 0.07) * S, 0.035 * S)
    return buf


def downsample(buf):
    """SSxSS -> SIZExSIZE 盒式降采样，返回每像素覆盖率(0..1)。"""
    out = [0.0] * (SIZE * SIZE)
    area = SS * SS
    for oy in range(SIZE):
        for ox in range(SIZE):
            acc = 0.0
            for j in range(SS):
                row = (oy * SS + j) * S + ox * SS
                for i in range(SS):
                    acc += buf[row + i]
            out[oy * SIZE + ox] = acc / area
    return out


def write_png(path, cov, color):
    raw = bytearray()
    r, g, b = color
    for y in range(SIZE):
        raw.append(0)  # filter type 0
        for x in range(SIZE):
            a = int(round(cov[y * SIZE + x] * 255))
            raw += bytes((r, g, b, a))

    def chunk(typ, data):
        c = typ + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)
    with open(path, 'wb') as f:
        f.write(sig)
        f.write(chunk(b'IHDR', ihdr))
        f.write(chunk(b'IDAT', idat))
        f.write(chunk(b'IEND', b''))


def main():
    os.makedirs(OUT, exist_ok=True)
    home = downsample(home_buf())
    plan = downsample(plan_buf())
    write_png(os.path.join(OUT, 'home.png'), home, NORMAL)
    write_png(os.path.join(OUT, 'home-active.png'), home, ACTIVE)
    write_png(os.path.join(OUT, 'plan.png'), plan, NORMAL)
    write_png(os.path.join(OUT, 'plan-active.png'), plan, ACTIVE)
    print('icons written to', os.path.normpath(OUT))


if __name__ == '__main__':
    main()
