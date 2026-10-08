"""Furniture and workstations of the forge-hall."""
import math

from mathutils import Vector

from . import layout as L
from .common import (P, Prop, anchor, ball, box, cyl, flat, merge, move, rng, rot, scale,
                     smooth_by_angle, subdivide, wobble, yaw_to)
from .shapes import lathe, prism

WOOD, WOOD_DARK, IRON, BRONZE = '#a2703f', '#6e4a2e', '#5d5a66', '#c08a3e'
STONE, STONE_DARK, PARCH = '#a48a74', '#7f6655', '#f1e2bf'


def _wood(bm, seed=0):
    wobble(bm, 0.012, 3.0, seed)
    return smooth_by_angle(bm, 0.6)


def furnace():
    c = P(*L.FURNACE)
    f = Prop('furnace', c)
    R, H = 3.1, 4.4
    ring = 0
    z = 0.0
    block_h = 0.55
    while z < H - 0.3:
        k = z / H
        r = R * math.sqrt(max(0.05, 1 - k * k)) + 0.25
        n = max(7, int(2 * math.pi * r / 0.95))
        off = (ring % 2) * math.pi / n
        for i in range(n):
            a = off + 2 * math.pi * i / n
            front = abs(math.atan2(math.sin(a + math.pi / 2), math.cos(a + math.pi / 2))) < 0.5
            if front and z < 1.9:
                continue  # the furnace mouth
            blk = box(2 * math.pi * r / n - 0.06, 0.7, block_h - 0.04, bev=0.07, seg=1)
            move(blk, 0, 0, -(block_h - 0.04) / 2)
            wobble(blk, 0.035, 2.5, ring * 31 + i)
            flat(blk)
            tilt = math.atan2(k * R, H) * 0.9
            f.part(blk, rng.choice([STONE, '#9c826c', '#ad937c']), at=(math.cos(a) * r, math.sin(a) * r, z + block_h / 2),
                   rz=a + math.pi / 2, rx=-tilt)
        z += block_h
        ring += 1
    # Arch over the mouth.
    for i in range(7):
        a = math.pi * i / 6
        x, zz = math.cos(a) * 1.15, math.sin(a) * 0.6 + 1.6
        st = box(0.42, 0.85, 0.5, bev=0.06)
        move(st, 0, 0, -0.25)
        rot(st, 0, -(a - math.pi / 2), 0)
        wobble(st, 0.02, 3, i + 400)
        f.part(st, STONE_DARK, at=(x, -R * 0.98, zz))
    # The fire within: visible through the mouth and the gaps between blocks.
    core = ball(2.55, 2)
    scale(core, 1, 1, 0.75)
    f.part(core, '#ff8a2a', mat='glow_ember', at=(0, 0, 1.2), ao=False)
    # Iron bands and the chimney.
    for zz, rr in ((1.95, R + 0.18), (3.3, R * 0.78 + 0.2)):
        band = lathe([(rr, 0), (rr + 0.06, 0.06), (rr + 0.06, 0.18), (rr, 0.24)], seg=28, cap_bottom=False, cap_top=False)
        f.part(band, IRON, at=(0, 0, zz))
    zc = H - 0.4
    for i in range(18):
        rr = 1.35 - i * 0.025
        for j in range(8):
            a = 2 * math.pi * j / 8 + (i % 2) * math.pi / 8
            st = box(2 * math.pi * rr / 8 - 0.05, 0.4, 0.5, bev=0.05, seg=1)
            wobble(st, 0.025, 3, i * 8 + j + 900)
            flat(st)
            f.part(st, rng.choice([STONE_DARK, '#8a705e']), at=(math.cos(a) * rr, math.sin(a) * rr, zc), rz=a + math.pi / 2)
        zc += 0.52
    # Coal pile and glowing cinders at the mouth.
    for i in range(26):
        a, rr = rng.uniform(-1.2, 1.2), rng.uniform(0.2, 1.4)
        lump = ball(0.12 + rng.random() * 0.1, 1)
        wobble(lump, 0.03, 4, i)
        flat(lump)
        hot = rng.random() < 0.25
        f.part(lump, '#ff8a2a' if hot else '#3a3036', mat='glow_ember' if hot else 'paint',
               at=(math.sin(a) * rr - 2.4, -R - 0.5 + math.cos(a) * rr * 0.5, 0.05))
    # Bellows (animated by the client while smiths "run commands").
    b = Prop('bellows', c + Vector((R + 0.9, -1.4, 0)), yaw=0.5, keep=True)
    board = box(1.3, 0.75, 0.06)
    b.part(_wood(board, 1), WOOD, at=(0, 0, 0.55), name='bellows_bottom')
    b.part(_wood(box(1.3, 0.75, 0.06), 2), WOOD, at=(0, 0, 0.95), ry=-0.12, name='bellows_top')
    leather = prism([(-0.62, -0.34), (0.62, -0.34), (0.62, 0.34), (-0.62, 0.34)], 0.38)
    b.part(smooth_by_angle(leather, 0.6), '#8a5232', at=(0, 0, 0.6), name='bellows_leather')
    b.part(cyl(0.06, 0.03, 0.8, seg=8), IRON, at=(-0.95, 0, 0.75), ry=math.pi / 2, name='bellows_nozzle')
    for sx in (-0.5, 0.5):
        b.part(box(0.12, 0.6, 0.55), WOOD_DARK, at=(sx, 0, 0), name=f'bellows_leg{sx}', keep=False)
    anchor('fire', c + Vector((0, -R - 0.6, 1.6)), color='#ff8a2a', intensity=60.0, range=24.0)


def anvils():
    furnace_c = P(*L.FURNACE)
    for i, (x, z) in enumerate(L.anvil_spots()):
        p = P(x, 0, z)
        yaw = yaw_to(p, furnace_c)  # long axis runs across the smith's view
        a = Prop(f'anvil_{i}', p, yaw=yaw)
        stump = lathe([(0.62, 0), (0.58, 0.55), (0.55, 0.6), (0.0, 0.62)], seg=12)
        wobble(stump, 0.03, 2, i)
        a.part(smooth_by_angle(stump, 0.5), '#8a5a36')
        # Classic anvil profile, extruded.
        body = box(0.62, 0.36, 0.14, bev=0.03)
        a.part(body, IRON, at=(0, 0, 0.62))
        a.part(box(0.3, 0.24, 0.22, bev=0.03), IRON, at=(0, 0, 0.76))
        a.part(box(0.95, 0.34, 0.16, bev=0.03), '#6c6977', at=(0, 0, 0.98))
        horn = cyl(0.16, 0.0, 0.5, seg=10)
        a.part(smooth_by_angle(horn, 0.8), '#6c6977', at=(0.47, 0, 1.06), ry=math.pi / 2)
        a.part(box(0.12, 0.28, 0.12, bev=0.02), '#6c6977', at=(-0.5, 0, 1.0))
        # The work: a glowing ingot on the face.
        a.part(box(0.38, 0.12, 0.06, bev=0.02), '#ff8a2a', mat='glow_ember', at=(0.05, 0, 1.14), keep=True,
               name=f'ingot_{i}', ao=False)
        # Quench barrel and a little tool rack.
        bar = Prop(f'quench_{i}', a.world(-1.05, 0.35, 0), yaw=yaw)
        _barrel(bar, 0.38, 0.75, water=True)
        rack = Prop(f'rack_{i}', a.world(1.15, 0.2, 0), yaw=yaw - math.pi / 2 + 0.2)
        rack.part(_wood(box(0.08, 0.08, 1.1), i), WOOD_DARK, at=(-0.35, 0, 0))
        rack.part(_wood(box(0.08, 0.08, 1.1), i + 1), WOOD_DARK, at=(0.35, 0, 0))
        rack.part(_wood(box(0.8, 0.06, 0.08), i + 2), WOOD, at=(0, 0, 0.95))
        for t in range(3):
            rack.part(cyl(0.025, 0.025, 0.55, seg=6), WOOD, at=(-0.22 + t * 0.22, -0.04, 0.4))
            rack.part(box(0.1, 0.08, 0.16 if t != 1 else 0.08, bev=0.015), IRON, at=(-0.22 + t * 0.22, -0.04, 0.32))
        top = a.world(0.05, 0, 1.15)
        # The smith stands on the furnace side, facing out into the hall across the anvil:
        # the fire rim-lights them from behind and the viewer sees their faces.
        away = Vector((p.x - furnace_c.x, p.y - furnace_c.y, 0)).normalized()
        stand = p - away * 0.95
        anchor(f'anvil_{i}', top)
        anchor(f'smith_{i}', stand, yaw=yaw_to(stand, p))


def _barrel(prop: Prop, r, h, water=False, at=(0, 0, 0), color=WOOD):
    prof = [(r * (0.86 + 0.14 * math.sin(math.pi * k / 6)), h * k / 6) for k in range(7)]
    bm = lathe(prof, seg=14, cap_top=not water)
    prop.part(smooth_by_angle(bm, 0.5), color, at=at)
    for k in (0.15, 0.85):
        rr = r * (0.86 + 0.14 * math.sin(math.pi * k)) + 0.015
        hoop = lathe([(rr, 0), (rr + 0.02, 0.01), (rr + 0.02, 0.06), (rr, 0.07)], seg=18, cap_bottom=False, cap_top=False)
        prop.part(hoop, IRON, at=(at[0], at[1], at[2] + h * k - 0.035))
    if water:
        prop.part(cyl(r * 0.84, r * 0.84, 0.02, seg=14), '#4f8fb0', at=(at[0], at[1], at[2] + h * 0.88), ao=False)


def master_table():
    c = P(*L.MASTER_TABLE)
    t = Prop('drafting', c, yaw=0.0)
    t.part(_wood(box(2.6, 1.5, 0.12), 3), WOOD, at=(0, 0, 1.0))
    for sx in (-1.1, 1.1):
        for sy in (-0.6, 0.6):
            t.part(_wood(box(0.14, 0.14, 1.0), 4), WOOD_DARK, at=(sx, sy, 0))
    t.part(box(2.2, 0.08, 0.1, bev=0.02), WOOD_DARK, at=(0, 0.6, 0.25))
    # The blueprint: a big unrolled map with two rolled ends.
    t.part(box(1.6, 1.0, 0.012, bev=0), PARCH, at=(0, 0, 1.12), rz=0.06, ao=False)
    for sx in (-0.82, 0.82):
        t.part(cyl(0.06, 0.06, 1.05, seg=10), '#e6d3a8', at=(sx, -0.53, 1.18), rx=-math.pi / 2, rz=0.06)
    for k in range(4):
        t.part(cyl(0.05, 0.05, 0.6, seg=8), rng.choice([PARCH, '#e9d6ae']), at=(-0.9 + k * 0.12, 0.55, 1.18),
               rz=math.pi / 2 + rng.uniform(-0.3, 0.3), rx=math.pi / 2)
    # Candle and inkpot.
    t.part(cyl(0.06, 0.06, 0.2, seg=10), '#f4ead6', at=(1.0, 0.45, 1.12))
    t.part(ball(0.045, 1), '#ffc46b', mat='glow_lamp', at=(1.0, 0.45, 1.36), ao=False)
    t.part(cyl(0.08, 0.06, 0.1, seg=10), '#2c2a3a', at=(0.75, 0.5, 1.12))
    # A tall stool.
    s = Prop('stool', c + Vector((0, -1.4, 0)))
    s.part(_wood(cyl(0.3, 0.3, 0.08, seg=12), 5), WOOD, at=(0, 0, 0.75))
    for k in range(3):
        a = k * 2 * math.pi / 3
        s.part(cyl(0.04, 0.05, 0.78, seg=6), WOOD_DARK, at=(math.cos(a) * 0.2, math.sin(a) * 0.2, 0))
    anchor('table', c + Vector((0, 0, 1.15)))
    master = c + Vector((0, -1.3, 0))
    anchor('master', master, yaw=yaw_to(master, c))
    visit = c + Vector((0, 1.35, 0))  # where a smith stands to hand back a failed ingot
    anchor('table_visit', visit, yaw=yaw_to(visit, c))
    anchor('light_lamp_table', c + Vector((1.0, 0.45, 1.6)), color='#ffc46b', intensity=8.0, range=7.0)


def library():
    c = P(*L.LIBRARY)
    yaw = yaw_to(c, Vector((0, 0, 0)))
    lib = Prop('library', c, yaw=yaw)
    W, D, H = 3.2, 0.5, 3.0
    for sx in (-W / 2, W / 2):
        lib.part(_wood(box(0.12, D, H), 6), WOOD_DARK, at=(sx, 0, 0))
    lib.part(_wood(box(W + 0.12, D, 0.1), 7), WOOD_DARK, at=(0, 0, H))
    lib.part(box(W, 0.05, H, bev=0), '#5a3c25', at=(0, D / 2 - 0.03, 0))
    for shelf in range(4):
        z = 0.1 + shelf * 0.72
        lib.part(_wood(box(W, D, 0.06), 8 + shelf), WOOD, at=(0, 0, z))
        x = -W / 2 + 0.12
        while x < W / 2 - 0.25:
            w = 0.07 + rng.random() * 0.08
            h = 0.38 + rng.random() * 0.22
            if rng.random() < 0.08:
                x += 0.2
                continue
            lean = rng.uniform(-0.12, 0.12) if rng.random() < 0.15 else 0.0
            lib.part(box(w, 0.32, h, bev=0.012, seg=1), rng.choice(['#8e3b32', '#3f5f8a', '#4f7a45', '#7a4f8a', '#b38a3a', '#5b3b2a']),
                     at=(x + w / 2, -0.03, z + 0.06), ry=lean)
            x += w + 0.01
    # Lectern with an open tome.
    lec = Prop('lectern', c + Vector((0, 0, 0)) + (Vector((0, 0, 0)) - c).normalized() * 2.2, yaw=yaw)
    lec.part(_wood(box(0.18, 0.18, 1.1), 9), WOOD_DARK, at=(0, 0, 0))
    lec.part(_wood(box(0.6, 0.6, 0.08), 10), WOOD_DARK, at=(0, 0, 0))
    lec.part(_wood(box(0.7, 0.5, 0.06), 11), WOOD, at=(0, 0, 1.12), rx=0.45)
    lec.part(box(0.62, 0.42, 0.05, bev=0.01), PARCH, at=(0, -0.02, 1.17), rx=0.45, ao=False)
    reader = lec.world(0, -0.75, 0)
    anchor('lectern', reader, yaw=yaw_to(reader, lec.world(0, 0, 0)))
    # Two more reading spots browsing the shelves.
    for k, sx in enumerate((-0.9, 0.9)):
        spot = lib.world(sx, -1.0, 0)
        anchor(f'shelf_{k}', spot, yaw=yaw_to(spot, lib.world(sx, 0, 0)))


def quest_board():
    c = P(*L.QUEST_BOARD)
    yaw = yaw_to(c, P(2, 0, 12))  # turned toward the default camera
    q = Prop('quest_board', c, yaw=yaw)
    for sx in (-1.2, 1.2):
        q.part(_wood(box(0.16, 0.16, 2.6), 12), WOOD_DARK, at=(sx, 0, 0))
    q.part(_wood(box(2.3, 0.1, 1.5), 13), '#b48552', at=(0, 0, 0.85))
    # Little roof.
    roof = prism([(-0.4, 0), (0.4, 0), (0, 0.35)], 2.8)
    rot(roof, math.pi / 2, 0, math.pi / 2)
    q.part(_wood(roof, 14), '#8c4f34', at=(1.4, 0, 2.55))
    for k in range(7):
        w, h = 0.38 + rng.random() * 0.16, 0.42 + rng.random() * 0.2
        x = -0.85 + (k % 4) * 0.56 + rng.uniform(-0.05, 0.05)
        z = 1.7 - (k // 4) * 0.62 + rng.uniform(-0.05, 0.05)
        q.part(box(w, 0.015, h, bev=0), rng.choice([PARCH, '#f6ead0', '#ecd9b0']), at=(x, -0.06, z - h / 2),
               ry=rng.uniform(-0.12, 0.12), ao=False)
        q.part(ball(0.035, 1), '#c0533b', at=(x, -0.08, z - 0.05), ao=False)
    anchor('quest_board', c + Vector((0, 0, 1.6)), yaw=yaw)
    reader = q.world(0, -1.1, 0)
    anchor('board_stand', reader, yaw=yaw_to(reader, c))


def treasury():
    c = P(*L.TREASURY)
    yaw = yaw_to(c, Vector((0, -2, 0)))
    t = Prop('treasury', c, yaw=yaw)
    # Chest.
    t.part(_wood(box(1.4, 0.85, 0.7), 15), '#8c5a34', at=(0, 0, 0))
    lid = cyl(0.43, 0.43, 1.4, seg=14)
    rot(lid, 0, math.pi / 2, 0)
    move(lid, -0.7, 0, 0)
    scale(lid, 1.0, 1.0, 0.55)
    t.part(smooth_by_angle(lid, 0.5), '#8c5a34', at=(0, 0, 0.7))
    for sx in (-0.5, 0.5):
        t.part(box(0.08, 0.88, 0.72, bev=0.01), BRONZE, at=(sx, 0, 0))
    # Gold spilling out: a mound and scattered coins (feeds the treasury HUD later).
    mound = ball(1.0, 3)
    scale(mound, 1.3, 1.0, 0.45)
    wobble(mound, 0.06, 3, 7)
    t.part(mound, '#f2c14e', mat='gold', at=(0, -1.0, -0.12), name='gold_pile', keep=True)
    for k in range(40):
        a, rr = rng.random() * 2 * math.pi, 0.4 + rng.random() * 1.4
        coin = cyl(0.07, 0.07, 0.02, seg=10)
        t.part(coin, '#f2c14e', mat='gold', at=(math.cos(a) * rr, -1.0 + math.sin(a) * rr * 0.8, 0.02 + rng.random() * 0.05),
               rx=rng.uniform(-0.4, 0.4), ry=rng.uniform(-0.4, 0.4))
    for k in range(5):
        gem = ball(0.08, 0)
        flat(gem)
        t.part(gem, rng.choice(['#ff5a7a', '#5ad1ff', '#8aff7a']), mat='glow_crystal', at=(rng.uniform(-0.6, 0.6), -1.0 + rng.uniform(-0.4, 0.3), 0.3),
               ao=False)
    anchor('treasury', c + Vector((0, 0, 1.2)), yaw=yaw)


def bell():
    c = P(*L.BELL)
    yaw = yaw_to(c, Vector((0, 0, 0)))
    b = Prop('bell_frame', c, yaw=yaw)
    for sx in (-0.9, 0.9):
        b.part(_wood(box(0.2, 0.2, 2.6), 16), WOOD_DARK, at=(sx, 0, 0))
        b.part(_wood(box(0.2, 0.7, 0.14), 17), WOOD_DARK, at=(sx, 0, 0))
    b.part(_wood(box(2.2, 0.24, 0.22), 18), WOOD, at=(0, 0, 2.55))
    bell_bm = lathe([(0.0, 0.0), (0.45, 0.0), (0.42, 0.08), (0.3, 0.3), (0.26, 0.6), (0.18, 0.72), (0.0, 0.75)], seg=18,
                    cap_bottom=False)
    move(bell_bm, 0, 0, -0.95)
    b.part(smooth_by_angle(bell_bm, 0.7), BRONZE, at=(0, 0, 2.55), name='bell', keep=True)
    anchor('bell', c + Vector((0, 0, 1.9)), yaw=yaw)
    ringer = b.world(0.35, -0.7, 0)
    anchor('bell_stand', ringer, yaw=yaw_to(ringer, b.world(0, 0, 0)))


def minecart_and_rail():
    start, end = P(*L.CART), P(*L.TUNNEL)
    ctrl = P(17.0, 0, 6.5)

    def bez(t):
        return start.lerp(ctrl, t).lerp(ctrl.lerp(end, t), t)

    steps = 28
    for k in range(steps):
        t0, t1 = k / steps, (k + 1) / steps
        a, b = bez(t0), bez(t1)
        d = (b - a)
        yaw = math.atan2(d.y, d.x)
        mid = (a + b) / 2
        r = Prop(f'rail_{k}', mid, yaw=yaw)
        r.part(box(0.18, 1.6, 0.1, bev=0.02, seg=1), WOOD_DARK, at=(0, 0, 0))
        for sy in (-0.55, 0.55):
            r.part(box(d.length + 0.02, 0.07, 0.09, bev=0), IRON, at=(0, sy, 0.1))
    d = bez(0.05) - start
    cart = Prop('minecart', start + Vector((0, 0, 0.02)), yaw=math.atan2(d.y, d.x), keep=True)
    tub = prism([(-0.75, -0.5), (0.75, -0.5), (0.85, 0.55), (-0.85, 0.55)], 1.0)
    rot(tub, -math.pi / 2, 0, 0)
    move(tub, 0, 0.5, 0.3)
    scale(tub, 1.0, 1.0, 0.75)
    cart.part(smooth_by_angle(tub, 0.6), '#7a6658', name='minecart_tub')
    for sx in (-0.5, 0.5):
        for sy in (-0.5, 0.5):
            w = cyl(0.17, 0.17, 0.08, seg=12)
            rot(w, math.pi / 2, 0, 0)
            cart.part(w, '#3e3a44', at=(sx, sy, 0.17), name=f'minecart_wheel_{sx}_{sy}')
    ore = ball(0.6, 1)
    scale(ore, 1.1, 0.75, 0.4)
    wobble(ore, 0.08, 3, 3)
    flat(ore)
    cart.part(ore, '#f2c14e', mat='gold', at=(0, 0, 0.95), name='minecart_ore')
    anchor('cart', start)
    # Waypoints for the minecart's trip into the tunnel.
    for k in range(13):
        anchor(f'rail_{k}', bez(k / 12) + Vector((0, 0, 0.02)))


def lanterns():
    spots = [(-6.5, 0, -6.5), (6.5, 0, -6.5), (-13.0, 0, 2.5), (14.5, 0, -6.0), (4.0, 0, 9.0), (-4.0, 0, 10.0)]
    for i, (x, _, z) in enumerate(spots):
        p = P(x, 0, z)
        l = Prop(f'lantern_{i}', p)
        l.part(_wood(box(0.14, 0.14, 2.3), 20 + i), WOOD_DARK, at=(0, 0, 0))
        l.part(_wood(box(0.6, 0.1, 0.1), 30 + i), WOOD_DARK, at=(0.25, 0, 2.2))
        l.part(box(0.28, 0.28, 0.05, bev=0.01), IRON, at=(0.5, 0, 1.68))
        l.part(box(0.3, 0.3, 0.05, bev=0.01), IRON, at=(0.5, 0, 2.0))
        for sx in (-0.12, 0.12):
            for sy in (-0.12, 0.12):
                l.part(box(0.025, 0.025, 0.3, bev=0), IRON, at=(0.5 + sx, sy, 1.72))
        l.part(ball(0.11, 1), '#ffc46b', mat='glow_lamp', at=(0.5, 0, 1.85), ao=False)
        anchor(f'light_lamp_{i}', l.world(0.5, 0, 1.85), color='#ffc46b', intensity=12.0, range=9.0)


def clutter():
    """Barrels, crates and sacks tucked along the walls."""
    spots = [(-15.5, 0, -3.0), (-16.0, 0, -1.2), (15.5, 0, -8.0), (16.5, 0, -6.5), (-8.0, 0, -14.0),
             (7.5, 0, -14.5), (12.5, 0, 8.5), (-14.0, 0, 7.0), (5.0, 0, -15.0)]
    for i, (x, _, z) in enumerate(spots):
        p = P(x, 0, z)
        g = Prop(f'clutter_{i}', p, yaw=rng.random() * 6.3)
        kind = i % 3
        if kind == 0:
            _barrel(g, 0.42, 0.95, color=rng.choice([WOOD, '#94653c']))
            if rng.random() < 0.6:
                _barrel(g, 0.38, 0.85, at=(0.9, 0.2, 0))
        elif kind == 1:
            g.part(_wood(box(0.9, 0.9, 0.8), i), '#a77a47')
            g.part(_wood(box(0.7, 0.7, 0.6), i + 1), '#b38755', at=(0.1, 0.05, 0.8), rz=0.3)
        else:
            sack = ball(0.42, 2)
            scale(sack, 1.0, 0.85, 1.1)
            wobble(sack, 0.05, 2.5, i)
            g.part(smooth_by_angle(sack, 1.0), '#c8ad7f', at=(0, 0, 0.4))
            g.part(cyl(0.12, 0.05, 0.18, seg=8), '#b0956a', at=(0, 0, 0.82))


def banners():
    """Two long banners hanging on the back wall either side of the chimney."""
    for i, x in enumerate((-4.5, 4.5)):
        p = P(x, 0, -18.0)
        yaw = yaw_to(p, Vector((p.x, 0, 0)))
        b = Prop(f'banner_{i}', p, yaw=yaw)
        cloth = box(1.3, 0.04, 4.0, bev=0)
        subdivide(cloth, 6)
        for v in cloth.verts:
            v.co.y += math.sin(v.co.z * 1.6 + i) * 0.06 + math.sin(v.co.x * 3) * 0.03
            if v.co.z < 0.35:
                v.co.z -= abs(v.co.x) * 0.5  # swallow-tail bottom
        b.part(smooth_by_angle(cloth, 1.0), '#b8483a' if i == 0 else '#3f6aa0', at=(0, 0, 4.0))
        b.part(cyl(0.05, 0.05, 1.6, seg=8), BRONZE, at=(-0.8, 0, 8.05), ry=math.pi / 2)
        b.part(box(0.5, 0.06, 0.5, bev=0.02), '#f2c14e', at=(0, -0.05, 6.6), ry=math.pi / 4, ao=False)


def build():
    furnace()
    anvils()
    master_table()
    library()
    quest_board()
    treasury()
    bell()
    minecart_and_rail()
    lanterns()
    clutter()
    banners()
