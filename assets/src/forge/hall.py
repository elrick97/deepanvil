"""The great forge-hall's architecture: cave, floor, sky hole, garden, rocks, crystals, tunnel."""
import math

import bmesh
from mathutils import Matrix, Vector, noise

from . import layout as L
from .common import (P, Prop, anchor, ball, box, cyl, flat, make, merge, move, rng, rot, scale,
                     smooth_by_angle, subdivide, wobble)
from .shapes import lathe, sector


def _fbm(v: Vector, octaves=4) -> float:
    return noise.fractal(v, 0.7, 2.0, octaves, noise_basis='PERLIN_ORIGINAL')


def cave():
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=6, radius=L.CAVE_RADIUS)
    sky = Vector(L.SKY_DIR_PRE).normalized()
    hole_faces, hole_pts = [], []
    for f in bm.faces:
        if f.calc_center_median().normalized().angle(sky) < 0.115:
            hole_faces.append(f)
    for v in bm.verts:
        n = v.co.normalized()
        # Big lumpy rock + horizontal strata ledges for a stylised, carved feel.
        d = _fbm(n * 2.2) * 2.6
        d += 0.55 * math.sin(v.co.z * 1.1 + _fbm(n * 4.0) * 2.0)
        if v.co.z < 2.0:
            d -= 1.2  # walls bulge inward a little near the floor
        v.co = n * (L.CAVE_RADIUS + d)
        v.co.z *= L.CAVE_SQUASH
    for f in hole_faces:
        hole_pts.append(f.calc_center_median())
    bmesh.ops.delete(bm, geom=hole_faces, context='FACES')
    bmesh.ops.reverse_faces(bm, faces=bm.faces)  # seen from inside
    flat(bm)
    make('cave', bm, '#a08670')
    hole = sum(hole_pts, Vector()) / len(hole_pts)
    return hole


def sky(hole: Vector):
    """A bright disc of sky just outside the opening, and a tuft of grass on its lip."""
    sun = P(*L.SUN_SPOT)
    d = (hole - sun).normalized()
    disc = cyl(4.2, 4.2, 0.1, seg=24)
    m = Matrix.Translation(hole + d * 1.2) @ d.to_track_quat('Z', 'Y').to_matrix().to_4x4()
    make('sky', disc, '#dff1ff', mat='glow_sky', matrix=m)
    anchor('sky_hole', hole)
    anchor('sun_spot', sun)


def floor():
    cx, _, cz = L.FLOOR_CENTER
    center = P(cx, 0, cz)
    garden = P(*L.SUN_SPOT)
    furnace = P(*L.FURNACE)
    r = 2.2
    ring = 0
    stones = []
    while r < 17.0:
        width = 1.1 + rng.random() * 0.25
        count = max(6, int(2 * math.pi * r / 1.5))
        offset = rng.random() * math.pi
        for k in range(count):
            a0 = offset + 2 * math.pi * k / count + 0.012 * (8 / r)
            a1 = offset + 2 * math.pi * (k + 1) / count - 0.012 * (8 / r)
            mid = (a0 + a1) / 2
            rm = r + width / 2
            p = center + Vector((math.cos(mid) * rm, math.sin(mid) * rm, 0))
            if (p - garden).length < 3.1 or (p - furnace).length < 3.6:
                continue
            h = 0.12 + rng.random() * 0.05
            bm = sector(r + 0.05, r + width - 0.05, a0, a1, h, steps=3)
            bm = bmesh_bevel(bm, 0.05)
            move(bm, center.x, center.y, -0.08 + rng.random() * 0.03)
            xform_tilt(bm, p, rng.uniform(-0.02, 0.02), rng.uniform(-0.02, 0.02))
            smooth_by_angle(bm, 0.9)
            shade = rng.choice(['#b9a084', '#ae957a', '#c2aa8d', '#a88f74'])
            stones.append(make(f'flag_{ring}_{k}', bm, shade))
        r += width
        ring += 1

    # Rough natural ground under and beyond the flagstones.
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=60, y_segments=60, size=26)
    for v in bm.verts:
        rr = v.co.xy.length
        v.co.z = -0.06 + _fbm(v.co * 0.12) * 0.25 + max(0.0, rr - 17.5) * 0.22
    flat(bm)
    make('ground', bm, '#8c7058')


def bmesh_bevel(bm, off):
    bmesh.ops.bevel(bm, geom=list(bm.edges) + list(bm.verts), offset=off, segments=1,
                    affect='EDGES', profile=0.6, clamp_overlap=True)
    return bm


def xform_tilt(bm, pivot, tx, ty):
    m = Matrix.Translation(pivot) @ Matrix.Rotation(tx, 4, 'X') @ Matrix.Rotation(ty, 4, 'Y') @ Matrix.Translation(-pivot)
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)


def garden():
    """The sunlit patch under the sky hole: a soft mound, grass, flowers, glowing mushrooms."""
    c = P(*L.SUN_SPOT)
    g = Prop('garden', c)
    mound = bmesh.new()
    bmesh.ops.create_circle(mound, cap_ends=True, cap_tris=True, segments=40, radius=3.0)
    subdivide(mound, 4)
    for v in mound.verts:
        rr = v.co.xy.length / 3.0
        v.co.z = max(0.0, 1 - rr * rr) * 0.35 + noise.noise(v.co * 1.3) * 0.04
    smooth_by_angle(mound, 1.2)
    g.part(mound, '#7fae4f')

    # Grass tufts: clusters of thin leaning blades.
    for _ in range(70):
        a, rr = rng.random() * 2 * math.pi, math.sqrt(rng.random()) * 2.7
        x, y = math.cos(a) * rr, math.sin(a) * rr
        z = max(0.0, 1 - (rr / 3.0) ** 2) * 0.35
        tuft = bmesh.new()
        for b in range(5):
            blade = cyl(0.035, 0.0, 0.25 + rng.random() * 0.25, seg=3)
            rot(blade, rng.uniform(-0.45, 0.45), rng.uniform(-0.45, 0.45), rng.random() * 6.3)
            move(blade, rng.uniform(-0.06, 0.06), rng.uniform(-0.06, 0.06))
            tuft = merge(tuft, blade)
        g.part(tuft, rng.choice(['#8cc25a', '#79b04a', '#9ccf66']), at=(x, y, z), ao=False)

    # Flowers.
    for _ in range(22):
        a, rr = rng.random() * 2 * math.pi, math.sqrt(rng.random()) * 2.5
        x, y = math.cos(a) * rr, math.sin(a) * rr
        z = max(0.0, 1 - (rr / 3.0) ** 2) * 0.35
        h = 0.25 + rng.random() * 0.2
        g.part(cyl(0.015, 0.015, h, seg=4), '#5e8f3a', at=(x, y, z), ao=False)
        g.part(ball(0.07, 1), rng.choice(['#ffd36b', '#ff9fb2', '#c6a8ff', '#ffffff']), at=(x, y, z + h), ao=False)

    # Glowing mushrooms around the rim.
    for k in range(7):
        a = k / 7 * 2 * math.pi + rng.random() * 0.4
        x, y = math.cos(a) * 3.1, math.sin(a) * 3.1
        s = 0.6 + rng.random() * 0.7
        g.part(cyl(0.05 * s, 0.06 * s, 0.25 * s, seg=8), '#efe6d2', at=(x, y, 0))
        cap = lathe([(0.0, 0.0), (0.2 * s, 0.0), (0.18 * s, 0.06 * s), (0.1 * s, 0.12 * s), (0.0, 0.14 * s)], seg=12)
        g.part(cap, '#9dff8a', mat='glow_mushroom', at=(x, y, 0.22 * s))

    # A bench to sit in the sun.
    b = Prop('bench', c + Vector((0, -3.6, 0)), yaw=0.0)
    b.part(box(1.8, 0.45, 0.1), '#9a6a42', at=(0, 0, 0.42))
    for sx in (-0.7, 0.7):
        b.part(box(0.14, 0.38, 0.42), '#6e4a2e', at=(sx, 0, 0))
    anchor('sprite_home', c + Vector((0, 0, 1.6)))


def rocks():
    """Stalagmites and boulders along the walls; a few stalactites high above."""
    furnace = P(*L.FURNACE)
    tunnel = P(*L.TUNNEL)
    for k in range(26):
        a = k / 26 * 2 * math.pi + rng.uniform(-0.08, 0.08)
        rr = 18.2 + rng.random() * 2.4
        p = Vector((math.cos(a) * rr, math.sin(a) * rr, 0))
        if (p - tunnel).length < 4.5 or (p - furnace).length < 5:
            continue
        h = 1.5 + rng.random() * 4.5
        bm = lathe([(0.9 + rng.random() * 0.6, 0), (0.7, h * 0.35), (0.35, h * 0.75), (0.05, h)], seg=8)
        subdivide(bm, 1)
        wobble(bm, 0.18, 1.2, k)
        flat(bm)
        make(f'stalagmite_{k}', bm, rng.choice(['#9b806a', '#8f7561', '#a48a73']), matrix=Matrix.Translation(p))
        if rng.random() < 0.6:
            bb = ball(0.6 + rng.random() * 0.7, 2)
            scale(bb, 1.0, 1.0, 0.7)
            wobble(bb, 0.15, 1.5, k + 50)
            flat(bb)
            q = p + Vector((rng.uniform(-1.4, 1.4), rng.uniform(-1.4, 1.4), 0.1))
            make(f'boulder_{k}', bb, '#94796a', matrix=Matrix.Translation(q))
    for k in range(10):
        a = rng.random() * 2 * math.pi
        rr = 9 + rng.random() * 9
        p = Vector((math.cos(a) * rr, math.sin(a) * rr, 0))
        top = L.CAVE_RADIUS * L.CAVE_SQUASH * math.sqrt(max(0.05, 1 - (rr / L.CAVE_RADIUS) ** 2))
        h = 1.2 + rng.random() * 2.2
        bm = lathe([(0.0, -h), (0.25, -h * 0.6), (0.55, -h * 0.15), (0.75, 0.6)], seg=7)
        wobble(bm, 0.1, 1.5, k + 99)
        flat(bm)
        make(f'stalactite_{k}', bm, '#9b806a', matrix=Matrix.Translation((p.x, p.y, top - 0.6)))


def crystals():
    furnace = P(*L.FURNACE)
    tunnel = P(*L.TUNNEL)
    lights = 0
    for k in range(12):
        a = k / 12 * 2 * math.pi + rng.uniform(-0.15, 0.15)
        rr = 17.3 + rng.random() * 1.5
        base = Vector((math.cos(a) * rr, math.sin(a) * rr, 0))
        if (base - tunnel).length < 4.5 or (base - furnace).length < 6:
            continue
        cl = Prop(f'crystal_{k}', base, yaw=rng.random() * 6.3)
        for j in range(4 + rng.randrange(5)):
            h = 0.8 + rng.random() * 2.6
            r = 0.16 + rng.random() * 0.16
            shard = lathe([(r, 0), (r, h * 0.8), (0.0, h)], seg=6)
            flat(shard)
            cl.part(shard, '#7fe8ff', mat='glow_crystal', at=(rng.uniform(-0.6, 0.6), rng.uniform(-0.6, 0.6), -0.1),
                    rx=rng.uniform(-0.5, 0.5), ry=rng.uniform(-0.5, 0.5))
        rock = ball(0.7, 1)
        scale(rock, 1.2, 1.0, 0.45)
        wobble(rock, 0.1, 2, k)
        flat(rock)
        cl.part(rock, '#7d6a62')
        if lights < 4:
            anchor(f'light_crystal_{lights}', base + Vector((0, 0, 1.5)), color='#7fe8ff', intensity=22.0, range=13.0)
            lights += 1


def tunnel():
    """A stone arch in the east wall where the mine rail disappears into darkness."""
    p = P(*L.TUNNEL)
    inward = (Vector((0, 0, 0)) - Vector((p.x, p.y, 0))).normalized()
    yaw = math.atan2(inward.y, inward.x) + math.pi / 2
    t = Prop('tunnel', p, yaw=yaw)
    span, rise, n = 2.4, 3.6, 13
    for i in range(n):
        a = math.pi * i / (n - 1)
        x, z = math.cos(a) * span, math.sin(a) * (rise - 1.6) + 1.6
        stone = box(0.55, 1.2, 0.75, bev=0.07, seg=1)
        move(stone, 0, 0, -0.375)
        rot(stone, 0, -(a - math.pi / 2), 0)
        wobble(stone, 0.03, 3, i)
        t.part(stone, '#8d7563', at=(x, 0, z))
    for sx in (-span, span):
        t.part(box(0.7, 1.3, 1.65, bev=0.07), '#86705e', at=(sx, 0, 0))
    # The dark mouth.
    mouth = cyl(span - 0.25, span - 0.25, 2.0, seg=20)
    rot(mouth, math.pi / 2, 0, 0)
    scale(mouth, 1.0, 1.0, 1.0)
    t.part(mouth, '#1a120d', at=(0, 0.9, 1.4), ao=False)
    t.part(box(2 * span - 0.5, 2.0, 1.4, bev=0), '#1a120d', at=(0, 0.9, 0), ao=False)
    anchor('tunnel', p + inward * 0.5)


def build():
    hole = cave()
    sky(hole)
    floor()
    garden()
    rocks()
    crystals()
    tunnel()
