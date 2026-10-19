#!/usr/bin/env python3
"""A small, readable string art solver in Python (numpy + Pillow).

This is a teaching version of the idea behind the String Art Maker in this repo (the full browser
solver is core.js). It is single-thread, black-on-white, circle frame only, and leaves out the
browser version's blur model, color mixing and settings search, but the core loop is the same:

  1. Put N nails evenly around a circle and precompute the pixels each nail-to-nail line covers.
  2. Keep a simulated board: every pixel starts white, and each line darkens the pixels it crosses
     by the share of the pixel the thread actually covers (thread width / pixel size).
  3. Greedy step: from the current nail, try every other nail and keep the line that lowers the
     error between the board and the photo the most (error measured in perceptual lightness, L*).
  4. Wind to that nail, update the board, repeat. Stop when no line lowers the error any more
     (or at --lines).

Usage:
    python3 stringart.py ../sample-einstein.jpg                     # writes stringart.png + stringart.txt
    python3 stringart.py photo.jpg --nails 288 --lines 2500 --frame-cm 40 --out my-art
    python3 stringart.py photo.jpg --gif                              # also writes an animated GIF of the build
"""
import argparse, math, time
import numpy as np
from PIL import Image, ImageOps

def srgb_to_linear(v):
    v = v / 255.0
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)

def lightness(Y):
    """CIE L* (0..100) from linear luminance Y (0..1): roughly how light a grey looks to the eye."""
    f = np.where(Y > 0.008856, np.cbrt(Y), 7.787 * Y + 16 / 116)
    return 116 * f - 16

def load_target(path, size):
    """Square-crop the photo around its centre, resize, and return target L* plus the circle mask."""
    im = ImageOps.exif_transpose(Image.open(path)).convert("L")
    im = ImageOps.fit(im, (size, size), Image.LANCZOS)
    target = lightness(srgb_to_linear(np.asarray(im, np.float64)))
    yy, xx = np.mgrid[0:size, 0:size]
    c = (size - 1) / 2
    inside = (xx - c) ** 2 + (yy - c) ** 2 <= c * c
    return target, inside

def nail_positions(n, size):
    """Nail 0 at the middle of the right side; numbers increase counter-clockwise (like the Maker)."""
    c = (size - 1) / 2
    a = 2 * np.pi * np.arange(n) / n
    return np.round(c + c * np.cos(a)).astype(int), np.round(c - c * np.sin(a)).astype(int)

def line_pixels(x0, y0, x1, y1, size):
    """Pixels on the straight line between two nails (one sample per step along the longer axis)."""
    L = max(abs(x1 - x0), abs(y1 - y0))
    if L == 0:
        return np.array([y0 * size + x0])
    s = np.arange(L + 1) / L
    xs = np.floor(x0 + (x1 - x0) * s + 0.5).astype(int)
    ys = np.floor(y0 + (y1 - y0) * s + 0.5).astype(int)
    return ys * size + xs

def solve(target, inside, n_nails=288, max_lines=2500, frame_mm=400, thread_mm=0.45, min_skip=None,
          thread_grey=12, on_line=None):
    size = target.shape[0]
    X, Y = nail_positions(n_nails, size)
    px_mm = frame_mm / size                       # millimetres per pixel
    skip = min_skip if min_skip is not None else max(1, n_nails // 20)   # avoid very short lines along the rim
    # precompute every line once: its pixels and how much of each pixel the thread covers
    pix, cover = {}, {}
    for i in range(n_nails):
        for j in range(i + skip, n_nails - (skip if i < skip else 0)):
            p = line_pixels(X[i], Y[i], X[j], Y[j], size)
            dx, dy = X[j] - X[i], Y[j] - Y[i]
            steps = max(abs(dx), abs(dy))
            # one sample per step along the longer axis; a diagonal step is longer than a pixel
            cover[i, j] = min(1.0, thread_mm / px_mm * math.hypot(dx, dy) / steps)
            pix[i, j] = p
    T = target.ravel()
    M = inside.ravel()
    board = np.ones(size * size)                  # linear luminance of the simulated board (1 = white)
    tau = float(srgb_to_linear(np.array(thread_grey)))   # luminance of the black thread
    used = set()
    order = [0]
    cur = 0
    for k in range(max_lines):
        best, best_gain, best_new = None, 0.0, None
        for j in range(n_nails):
            key = (min(cur, j), max(cur, j))
            if key not in pix or key in used:
                continue
            p = pix[key]
            p = p[M[p]]
            old = board[p]
            new = old + cover[key] * (tau - old)  # thread on top of what is already there
            gain = np.sum((lightness(old) - T[p]) ** 2) - np.sum((lightness(new) - T[p]) ** 2)
            if gain > best_gain:
                best, best_gain, best_new = j, gain, (p, new)
        if best is None:                          # no line brings the board closer to the photo
            break
        p, new = best_new
        board[p] = new
        used.add((min(cur, best), max(cur, best)))
        order.append(best)
        if on_line:
            on_line(k + 1, cur, best)
        cur = best
    return order, (X, Y)

def render(order, XY, size_src, out_px=800, frame_mm=400, thread_mm=0.45, thread_grey=12, upto=None, ss=2):
    """Draw the winding with the same board model the solver uses: each line darkens the pixels it crosses
    by the share of the pixel the thread covers. Drawn at ss times out_px, then averaged in linear light
    (averaging sRGB values would make the picture look darker than the real board)."""
    final_px, out_px = out_px, out_px * ss
    X, Y = XY
    k = (out_px - 1) / (size_src - 1)
    Xo, Yo = np.round(X * k).astype(int), np.round(Y * k).astype(int)
    px_mm = frame_mm / out_px
    tau = float(srgb_to_linear(np.array(thread_grey)))
    board = np.ones(out_px * out_px)
    n = len(order) - 1 if upto is None else upto
    for a, b in zip(order[:n], order[1:n + 1]):
        p = line_pixels(Xo[a], Yo[a], Xo[b], Yo[b], out_px)
        dx, dy = Xo[b] - Xo[a], Yo[b] - Yo[a]
        steps = max(abs(dx), abs(dy), 1)
        c = min(1.0, thread_mm / px_mm * math.hypot(dx, dy) / steps)
        board[p] += c * (tau - board[p])
    board = board.reshape(final_px, ss, final_px, ss).mean(axis=(1, 3))
    # linear luminance -> sRGB for display
    v = np.where(board <= 0.0031308, 12.92 * board, 1.055 * board ** (1 / 2.4) - 0.055)
    return Image.fromarray(np.clip(255 * v, 0, 255).astype(np.uint8))

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("photo")
    ap.add_argument("--nails", type=int, default=288)
    ap.add_argument("--lines", type=int, default=2500, help="maximum number of lines (it may stop sooner)")
    ap.add_argument("--frame-cm", type=float, default=40, help="frame diameter, sets thread width relative to the image")
    ap.add_argument("--res", type=int, default=200,
                    help="working resolution in pixels. About 2 mm per pixel works well: each pixel is then a small "
                         "patch of the board that the eye averages from a few steps away")
    ap.add_argument("--out", default="stringart", help="output name without extension")
    ap.add_argument("--gif", action="store_true", help="also write <out>.gif showing the build")
    a = ap.parse_args()
    target, inside = load_target(a.photo, a.res)
    t0 = time.time()
    def progress(k, i, j):
        if k % 250 == 0:
            print(f"  {k} lines", flush=True)
    order, XY = solve(target, inside, a.nails, a.lines, a.frame_cm * 10, on_line=progress)
    print(f"{len(order) - 1} lines on {a.nails} nails in {time.time() - t0:.1f} s")
    render(order, XY, a.res, 800, a.frame_cm * 10).save(a.out + ".png")
    with open(a.out + ".txt", "w") as f:
        f.write(f"# String art nail order: {a.nails} nails on a circle, nail 0 at the middle of the right side,\n"
                f"# numbers increase counter-clockwise. One nail per row, in winding order.\n")
        f.write("\n".join(map(str, order)) + "\n")
    print("wrote", a.out + ".png", a.out + ".txt")
    if a.gif:
        n = len(order) - 1
        marks = sorted({max(1, round(n * (i / 40) ** 2)) for i in range(1, 41)})
        frames = [render(order, XY, a.res, 360, a.frame_cm * 10, upto=m) for m in marks]
        frames += [frames[-1]] * 15
        frames[0].save(a.out + ".gif", save_all=True, append_images=frames[1:], duration=80, loop=0)
        print("wrote", a.out + ".gif")

if __name__ == "__main__":
    main()
