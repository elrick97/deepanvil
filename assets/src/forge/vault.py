"""The Vault of Main: a great round rune-door in the back wall, guarded by Odin.

Pieces the client will drive (keep=True): the door (swings open on a merge), the three
gate rune rings + the review rune (light up per gate), the scales (tip when judging).
Authored around a local origin: +Y is into the wall, the door faces -Y (the hall).
"""
import math

from mathutils import Vector

from .common import Prop, anchor, ball, box, cyl, flat, rng, scale, smooth_by_angle, wobble
from .shapes import lathe, prism

STONE, STONE_DARK, IRON, BRONZE, GOLD = '#9a8573', '#6f5c4e', '#4f4c58', '#c08a3e', '#f2c14e'
RUNE = '#9fd8ff'


def _rot_x(bm):
    """Stand a Z-axis shape up so it faces -Y (towards the hall)."""
    from .common import rot
    return rot(bm, math.pi / 2, 0, 0)


def door_and_frame(v: Prop):
    R = 2.4
    # Stone arch: a ring of wedge blocks around the door.
    n = 18
    for i in range(n):
        a0, a1 = 2 * math.pi * i / n + 0.012, 2 * math.pi * (i + 1) / n - 0.012
        pts = []
        for s in range(4):
            a = a0 + (a1 - a0) * s / 3
            pts.append((math.cos(a) * (R + 0.75), math.sin(a) * (R + 0.75)))
        for s in range(3, -1, -1):
            a = a0 + (a1 - a0) * s / 3
            pts.append((math.cos(a) * (R + 0.08), math.sin(a) * (R + 0.08)))
        blk = prism(pts, 0.9)
        wobble(blk, 0.03, 2, i)
        flat(blk)
        _rot_x(blk)
        v.part(blk, rng.choice([STONE, '#a48e7b', STONE_DARK]), at=(0, 0.45, R + 0.15))
    # The door itself (separate node: it swings open).
    door = cyl(R, R, 0.35, seg=40)
    smooth_by_angle(door, 0.6)
    _rot_x(door)
    v.part(door, '#7d6a5c', at=(0, 0.3, R + 0.15), name='vault_door', keep=True)
    # Iron spokes and rim on the door face.
    rim = lathe([(R - 0.12, 0), (R + 0.02, 0.0), (R + 0.02, 0.08), (R - 0.12, 0.08)], seg=48, cap_bottom=False, cap_top=False)
    _rot_x(rim)
    v.part(rim, IRON, at=(0, -0.02, R + 0.15), name='vault_door_rim', keep=True)
    for k in range(8):
        a = k * math.pi / 4
        spoke = box(0.12, 0.06, R * 2 - 0.4, bev=0.015)
        from .common import move, rot
        move(spoke, 0, 0, -(R - 0.2))
        rot(spoke, 0, a, 0)
        v.part(spoke, IRON, at=(0, -0.08, R + 0.15), name=f'vault_spoke_{k}', keep=True)
    # Rune rings: tests (outer), types (middle), lint (inner), review (the eye at the centre).
    for gate, r, count in (('tests', 1.95, 16), ('types', 1.4, 12), ('lint', 0.9, 8)):
        for k in range(count):
            a = 2 * math.pi * (k + 0.5) / count
            glyph = _glyph(k + len(gate))
            from .common import move, rot
            rot(glyph, 0, -a + math.pi / 2, 0)
            move(glyph, math.cos(a) * r, 0, math.sin(a) * r)
            v.part(glyph, RUNE, mat=f'glow_rune_{gate}', at=(0, -0.08, R + 0.15), name=f'rune_{gate}_{k}', keep=True, ao=False)
    eye = lathe([(0.0, 0.0), (0.42, 0.0), (0.42, 0.05), (0.3, 0.07), (0.0, 0.09)], seg=24)
    _rot_x(eye)
    v.part(eye, RUNE, mat='glow_rune_review', at=(0, -0.03, R + 0.15), name='rune_review', keep=True, ao=False)
    pupil = ball(0.13, 2)
    v.part(pupil, '#1d2433', at=(0, -0.04, R + 0.15), name='rune_review_pupil', keep=True)
    anchor('vault_door', v.world(0, 0, R + 0.15))


def _glyph(seed: int):
    """A small angular rune: 2-3 strokes, different per position."""
    from .common import merge, move, rot
    strokes = [box(0.05, 0.03, 0.32, bev=0)]
    r = (seed * 7919) % 5
    if r != 0:
        s = box(0.05, 0.03, 0.18, bev=0)
        rot(s, 0, 0.7 if r % 2 else -0.7, 0)
        move(s, 0.06, 0, 0.05 + 0.04 * (r % 3))
        strokes.append(s)
    if r > 2:
        s = box(0.05, 0.03, 0.16, bev=0)
        rot(s, 0, -0.7, 0)
        move(s, -0.06, 0, 0.12)
        strokes.append(s)
    g = merge(*strokes)
    move(g, 0, 0, -0.16)
    return g


def dais_and_scales(v: Prop):
    # Two round steps in front of the door.
    for i, (r, h) in enumerate(((3.6, 0.22), (2.9, 0.22))):
        step = cyl(r, r, h, seg=36)
        wobble(step, 0.02, 2, 70 + i)
        flat(step)
        v.part(step, '#a99480', at=(0, -2.6, i * 0.22))
    # The Scales of Judgment, where smiths lay their pieces.
    sc = Prop('scales', v.world(1.2, -3.3, 0.44), yaw=0.0, keep=True)
    sc.part(cyl(0.08, 0.06, 1.5, seg=10), BRONZE, name='scales_post')
    sc.part(cyl(0.25, 0.3, 0.12, seg=14), BRONZE, name='scales_foot')
    beam = box(1.5, 0.08, 0.08, bev=0.02)
    sc.part(beam, BRONZE, at=(0, 0, 1.48), name='scales_beam')
    for side in (-1, 1):
        for k in range(3):
            a = 2 * math.pi * k / 3
            chain = cyl(0.012, 0.012, 0.55, seg=4)
            sc.part(chain, IRON, at=(side * 0.7 + math.cos(a) * 0.14, math.sin(a) * 0.14, 0.95), name=f'scales_chain_{side}_{k}')
        pan = lathe([(0.0, 0.0), (0.24, 0.0), (0.28, 0.06), (0.0, 0.06)], seg=18)
        sc.part(pan, BRONZE, at=(side * 0.7, 0, 0.9), name=f'scales_pan_{"l" if side < 0 else "r"}')
    sc.part(box(0.26, 0.1, 0.06, bev=0.015), '#ff8a2a', mat='glow_ember', at=(-0.7, 0, 0.98), name='scales_offering', ao=False)
    anchor('scales', v.world(1.2, -3.3, 1.4))
    anchor('odin', v.world(-0.6, -3.1, 0.44))  # local -Y: faces the hall, like the vault
    anchor('offer_spot', v.world(1.2, -4.3, 0.44))


def rune_stones(v: Prop):
    """Three standing stones along the approach: Tests, Types, Lint. Their runes light per gate."""
    for i, (gate, x, y) in enumerate((('tests', -3.6, -3.8), ('types', 3.7, -3.6), ('lint', -3.4, -1.2))):
        p = Prop(f'stone_{gate}', v.world(x, y, 0), yaw=rng.uniform(-0.15, 0.15))
        mono = lathe([(0.55, 0), (0.5, 0.9), (0.42, 1.8), (0.25, 2.3), (0.0, 2.45)], seg=7)
        scale(mono, 1.0, 0.6, 1.0)
        wobble(mono, 0.05, 1.5, 30 + i)
        flat(mono)
        p.part(mono, rng.choice([STONE, '#8f7a68']))
        for k in range(3):
            g = _glyph(k * 3 + i)
            p.part(g, RUNE, mat=f'glow_rune_{gate}', at=(0, -0.33, 0.9 + k * 0.42), name=f'stone_rune_{gate}_{k}', keep=True, ao=False)
        anchor(f'gate_{gate}', p.world(0, -0.5, 1.4))


def braziers(v: Prop):
    for i, x in enumerate((-2.2, 2.2)):
        b = Prop(f'brazier_{i}', v.world(x, -1.7, 0.44))
        b.part(cyl(0.05, 0.08, 0.9, seg=8), IRON)
        bowl = lathe([(0.05, 0.0), (0.3, 0.12), (0.36, 0.28), (0.3, 0.3), (0.0, 0.18)], seg=14)
        b.part(bowl, IRON, at=(0, 0, 0.88))
        flame = lathe([(0.0, 0.0), (0.22, 0.05), (0.16, 0.3), (0.05, 0.55), (0.0, 0.62)], seg=10)
        wobble(flame, 0.03, 4, i)
        b.part(flame, RUNE, mat='glow_rune', at=(0, 0, 1.12), name=f'brazier_flame_{i}', keep=True, ao=False)
        anchor(f'light_rune_{i}', b.world(0, 0, 1.5), color=RUNE, intensity=10.0, range=8.0)


def build(at: Vector, yaw: float = 0.0):
    v = Prop('vault', at, yaw=yaw)
    door_and_frame(v)
    dais_and_scales(v)
    rune_stones(v)
    braziers(v)
    return v
