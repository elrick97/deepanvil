"""Higher-level shape builders: lathe (revolve a profile) and prism (extrude a polygon)."""
import math

import bmesh

from .common import _fresh


def lathe(profile, seg=16, cap_bottom=True, cap_top=True):
    """Revolve [(radius, z), ...] (bottom to top) around Z."""
    bm = _fresh()
    rings = []
    for r, z in profile:
        ring = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            ring.append(bm.verts.new((r * math.cos(a), r * math.sin(a), z)))
        rings.append(ring)
    for k in range(len(rings) - 1):
        a, b = rings[k], rings[k + 1]
        for i in range(seg):
            j = (i + 1) % seg
            bm.faces.new((a[i], a[j], b[j], b[i]))
    if cap_bottom and profile[0][0] > 1e-4:
        bm.faces.new(list(reversed(rings[0])))
    if cap_top and profile[-1][0] > 1e-4:
        bm.faces.new(rings[-1])
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def prism(points, height):
    """Extrude a CCW polygon [(x, y), ...] from z=0 to z=height."""
    bm = _fresh()
    bot = [bm.verts.new((x, y, 0.0)) for x, y in points]
    top = [bm.verts.new((x, y, height)) for x, y in points]
    n = len(points)
    bm.faces.new(list(reversed(bot)))
    bm.faces.new(top)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((bot[i], bot[j], top[j], top[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def sector(r0, r1, a0, a1, height, steps=3):
    """Annular sector slab (a curved flagstone)."""
    pts = []
    for s in range(steps + 1):
        a = a0 + (a1 - a0) * s / steps
        pts.append((r1 * math.cos(a), r1 * math.sin(a)))
    for s in range(steps, -1, -1):
        a = a0 + (a1 - a0) * s / steps
        pts.append((r0 * math.cos(a), r0 * math.sin(a)))
    return prism(pts, height)
