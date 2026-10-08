"""Odin, rigged: the concept model (odin.py) rebuilt on a taller crew-style skeleton.

Same approach as the dwarves (crew.py): every part is rigidly bound to one bone, clips are
keyframed per bone and exported as named glTF animations. Unlike the crew there is only one
Odin, so his colours are painted straight into the vertex colours (no slot recolouring).

Also exports a free-flying raven (`raven` with `raven_wing.L/R` children) that the client
clones for Huginn's and Muninn's flights; Huginn's perched twin rides Odin's shoulder as the
`huginn` mesh, hidden while he is away.

Blender space: Odin faces -Y (three.js +Z), right hand (Gungnir) on -X.
"""
import math

from mathutils import Vector

from . import crew
from .common import ball, box, cyl, make, merge, move, rot, scale, smooth_by_angle, uvball, wobble
from .crew import X, Y, Z
from .odin import BEARD, CLOAK, CLOAK_IN, GOLD, LEATHER, RAVEN, RUNE, SKIN, TUNIC
from .shapes import lathe

HAT = '#2c3448'
BONES = [
    ('root', (0, 0, 0), (0, 0, 0.3), None),
    ('hips', (0, 0, 0.95), (0, 0, 1.15), 'root'),
    ('spine', (0, 0, 1.15), (0, 0, 1.62), 'hips'),
    ('head', (0, 0, 1.7), (0, 0, 2.25), 'spine'),
    ('upper_arm.L', (0.47, 0, 1.52), (0.47, 0, 1.26), 'spine'),
    ('forearm.L', (0.47, 0, 1.26), (0.47, 0, 1.02), 'upper_arm.L'),
    ('hand.L', (0.47, 0, 1.02), (0.47, 0, 0.9), 'forearm.L'),
    ('upper_arm.R', (-0.47, 0, 1.52), (-0.47, 0, 1.26), 'spine'),
    ('forearm.R', (-0.47, 0, 1.26), (-0.47, 0, 1.02), 'upper_arm.R'),
    ('hand.R', (-0.47, 0, 1.02), (-0.47, 0, 0.9), 'forearm.R'),
]


def part(name, bm, color, bone, slot='paint', variant=None, **kw):
    ob = crew.part(name, bm, slot, bone, variant=variant, **kw)
    ob['base'] = color
    return ob


def body():
    cloak = lathe([(0.0, 0.02), (0.62, 0.02), (0.58, 0.4), (0.5, 1.0), (0.44, 1.45), (0.36, 1.62), (0.18, 1.72), (0.0, 1.74)], seg=24)
    scale(cloak, 1.0, 0.82, 1.0)
    for v in cloak.verts:  # open at the front, the tunic shows through
        if v.co.y < -0.3 and v.co.z < 1.5 and abs(v.co.x) < 0.16:
            v.co.y *= 0.82
    wobble(cloak, 0.02, 3, 11)
    part('cloak', cloak, CLOAK, 'hips')
    tunic = lathe([(0.0, 0.2), (0.3, 0.2), (0.33, 0.9), (0.28, 1.4), (0.0, 1.5)], seg=16)
    part('tunic', tunic, TUNIC, 'hips', at=(0, -0.12, 0))
    belt = lathe([(0.34, 0), (0.35, 0.02), (0.35, 0.08), (0.34, 0.1)], seg=20, cap_bottom=False, cap_top=False)
    part('belt', belt, LEATHER, 'hips', at=(0, -0.1, 0.95))
    part('buckle', box(0.1, 0.03, 0.09, bev=0.01), GOLD, 'hips', at=(0, -0.46, 0.95))
    mantle = lathe([(0.44, 0.0), (0.46, 0.05), (0.38, 0.17), (0.2, 0.26), (0.0, 0.28)], seg=20)
    scale(mantle, 1.18, 0.78, 1.0)
    wobble(mantle, 0.025, 6, 12)  # shaggy fur
    part('mantle', mantle, CLOAK_IN, 'spine', at=(0, 0, 1.5))
    part('clasp', ball(0.06, 2), GOLD, 'spine', at=(0.0, -0.4, 1.62))
    for side, x in (('L', 0.47), ('R', -0.47)):
        part(f'sleeve_up.{side}', cyl(0.12, 0.135, 0.3, seg=10), CLOAK, f'upper_arm.{side}', at=(x, 0, 1.24))
        part(f'sleeve_lo.{side}', cyl(0.13, 0.11, 0.27, seg=10), CLOAK, f'forearm.{side}', at=(x, 0, 0.99))
        hand = ball(0.085, 2)
        scale(hand, 0.9, 1.0, 1.1)
        part(f'hand.{side}', hand, SKIN, f'hand.{side}', at=(x, -0.03, 0.94))


def head():
    part('head', uvball(0.21, 18, 12), SKIN, 'head', at=(0, -0.05, 1.93))
    nose = ball(0.07, 2)
    scale(nose, 0.8, 1.0, 1.1)
    part('nose', nose, SKIN, 'head', at=(0, -0.26, 1.9))
    patch = cyl(0.065, 0.065, 0.025, seg=12)
    rot(patch, math.pi / 2, 0, 0)
    part('patch', patch, '#1f1a1a', 'head', at=(-0.08, -0.23, 1.98))
    strap = lathe([(0.215, 0), (0.218, 0.005), (0.218, 0.025), (0.215, 0.03)], seg=24, cap_bottom=False, cap_top=False)
    part('strap', strap, '#1f1a1a', 'head', at=(0, -0.05, 1.96), ry=-0.25)
    part('eye', ball(0.03, 1), RUNE, 'head', slot='glow_rune', at=(0.08, -0.235, 1.985))
    for x in (-0.08, 0.08):
        part(f'brow_{x}', box(0.12, 0.05, 0.04, bev=0.015), BEARD, 'head', at=(x, -0.22, 2.04), ry=0.15 if x > 0 else -0.15)
    beard = lathe([(0.0, -0.9), (0.08, -0.82), (0.18, -0.55), (0.23, -0.25), (0.22, 0.0), (0.17, 0.1), (0.0, 0.13)], seg=16)
    scale(beard, 0.85, 0.62, 0.95)
    wobble(beard, 0.02, 5, 13)
    part('beard', beard, BEARD, 'head', at=(0, -0.33, 1.77), rx=-0.14, smooth=1.0)
    for x, rz in ((0.08, -0.45), (-0.08, 0.45)):
        m = ball(0.07, 1)
        scale(m, 1.7, 0.8, 0.7)
        part(f'stache_{x}', m, BEARD, 'head', at=(x, -0.27, 1.85), rz=rz)
    brim = cyl(0.46, 0.46, 0.03, seg=28)
    wobble(brim, 0.015, 3, 14)
    part('brim', brim, HAT, 'head', at=(0, -0.04, 2.08), rx=0.1, smooth=1.0)
    crown = lathe([(0.21, 0.0), (0.2, 0.18), (0.14, 0.32), (0.05, 0.38), (0.0, 0.38)], seg=18)
    for v in crown.verts:
        v.co.y += (v.co.z / 0.38) ** 2 * 0.08  # slouches backwards
    part('crown', crown, HAT, 'head', at=(0, -0.02, 2.1), rx=0.1)
    band = lathe([(0.212, 0), (0.215, 0.01), (0.215, 0.06), (0.212, 0.07)], seg=20, cap_bottom=False, cap_top=False)
    part('band', band, LEATHER, 'head', at=(0, -0.02, 2.11), rx=0.1)


def gungnir():
    x, y = -0.47, -0.1
    part('gungnir_shaft', cyl(0.035, 0.03, 2.55, seg=8), '#8a5a36', 'hand.R', at=(x, y, 0.02))
    part('gungnir_collar', cyl(0.05, 0.05, 0.12, seg=8), GOLD, 'hand.R', at=(x, y, 2.52))
    blade = lathe([(0.0, 0.0), (0.075, 0.1), (0.06, 0.35), (0.0, 0.52)], seg=4)
    scale(blade, 1.0, 0.35, 1.0)
    part('gungnir_blade', blade, RUNE, 'hand.R', slot='glow_rune', at=(x, y, 2.62), smooth=None)


def _raven_body():
    body = uvball(0.13, 12, 8)
    scale(body, 0.8, 1.35, 0.85)
    smooth_by_angle(body, 1.0)
    rot(body, -0.35, 0, 0)
    move(body, 0, 0, 0.1)
    head_ = uvball(0.075, 10, 7)
    move(head_, 0, -0.16, 0.22)
    beak = cyl(0.025, 0.0, 0.1, seg=6)
    rot(beak, math.pi / 2, 0, 0)
    move(beak, 0, -0.23, 0.215)
    tail = box(0.1, 0.18, 0.02, bev=0.005)
    rot(tail, 0.4, 0, 0)
    move(tail, 0, 0.18, 0.04)
    eyes = merge(*(move(ball(0.012, 1), x, -0.22, 0.24) for x in (-0.03, 0.03)))
    return merge(body, head_, beak, tail), eyes


def huginn():
    """Perched on Odin's left shoulder, wings folded."""
    at, yaw = Vector((0.42, 0.05, 1.68)), 0.3
    body, eyes = _raven_body()
    for side in (-1, 1):
        wing = box(0.035, 0.24, 0.12, bev=0.01)
        rot(wing, 0, 0, side * 0.08)
        move(wing, side * 0.1, 0.02, 0.06)
        body = merge(body, wing)
    for bm, slot, color in ((body, 'paint', RAVEN), (eyes, 'glow_rune', RUNE)):
        rot(bm, 0, 0, yaw)
        part(f'huginn_{slot}', bm, color, 'spine', slot=slot, variant='huginn', at=at, smooth=None)


def free_raven(at=Vector((0, 3, 0))):
    """The flying raven: body + two wings hinged at the shoulders (spread flat when posed)."""
    body, eyes = _raven_body()
    rv = make('raven', body, RAVEN, keep=True)
    rv.location = at
    ey = make('raven_eyes', eyes, RUNE, mat='glow_rune', keep=True, ao=False)
    ey.parent = rv
    wings = []
    for side, lr in ((1, 'L'), (-1, 'R')):
        w = box(0.34, 0.17, 0.025, bev=0.008)
        for v in w.verts:  # taper to a point at the tip, swept back
            t = (v.co.x + 0.17) / 0.34
            v.co.y = v.co.y * (1 - 0.55 * t) + 0.07 * t
        move(w, side * 0.17, 0, 0)
        ob = make(f'raven_wing.{lr}', w, '#262a38', keep=True)
        ob.parent = rv
        ob.location = (side * 0.07, 0.0, 0.14)
        wings.append(ob)
    return [rv, ey, *wings]


def animations(rig):
    A = lambda *r: list(r)  # noqa: E731
    action = crew.action
    action(rig, 'idle_watch', 120, {
        'spine': [(1, A((X, 0.0))), (60, A((X, 0.025))), (120, A((X, 0.0)))],
        'head': [(1, A((Z, 0.0))), (30, A((Z, 0.28), (X, 0.05))), (60, A((Z, 0.0))), (90, A((Z, -0.22))), (120, A((Z, 0.0)))],
        'upper_arm.L': [(1, A((Y, -0.08))), (60, A((Y, -0.11))), (120, A((Y, -0.08)))],
        'root_z': [(1, 0.0), (60, -0.01), (120, 0.0)],
    })
    action(rig, 'inspect', 48, {
        'spine': [(1, A((X, 0.16), (Z, 0.4))), (24, A((X, 0.2), (Z, 0.42))), (48, A((X, 0.16), (Z, 0.4)))],
        'head': [(1, A((X, 0.3), (Z, 0.25))), (16, A((X, 0.34), (Z, 0.18))), (32, A((X, 0.3), (Z, 0.3))), (48, A((X, 0.3), (Z, 0.25)))],
        'upper_arm.L': [(1, A((X, -0.55), (Y, -0.15))), (48, A((X, -0.55), (Y, -0.15)))],
        'forearm.L': [(1, A((X, -0.7))), (20, A((X, -0.85))), (48, A((X, -0.7)))],
    })
    action(rig, 'read', 72, {
        'spine': [(1, A((X, 0.08))), (72, A((X, 0.08)))],
        'head': [(1, A((X, 0.38))), (24, A((X, 0.4), (Z, 0.1))), (48, A((X, 0.38), (Z, -0.1))), (72, A((X, 0.38)))],
        'upper_arm.L': [(1, A((X, -0.55), (Y, 0.15))), (72, A((X, -0.55), (Y, 0.15)))],
        'forearm.L': [(1, A((X, -1.25))), (36, A((X, -1.35))), (72, A((X, -1.25)))],
    })
    action(rig, 'approve', 40, {
        'head': [(1, A((X, 0.0))), (8, A((X, 0.3))), (14, A((X, 0.0))), (20, A((X, 0.25))), (28, A((X, 0.0))), (40, A((X, 0.0)))],
        'upper_arm.R': [(1, A((X, 0.0))), (12, A((X, -1.1))), (17, A((X, 0.05))), (22, A((X, 0.0))), (40, A((X, 0.0)))],
        'forearm.R': [(1, A((X, 0.0))), (12, A((X, 1.1))), (17, A((X, -0.05))), (22, A((X, 0.0))), (40, A((X, 0.0)))],
        'spine': [(1, A((X, 0.0))), (17, A((X, 0.06))), (26, A((X, 0.0))), (40, A((X, 0.0)))],
        'root_z': [(1, 0.0), (17, -0.03), (24, 0.0), (40, 0.0)],
    }, loop=False)
    action(rig, 'send_back', 48, {
        'head': [(1, A((Z, 0.0))), (8, A((Z, 0.3))), (15, A((Z, -0.3))), (22, A((Z, 0.28))), (29, A((Z, -0.22))), (36, A((Z, 0.0))), (48, A((Z, 0.0)))],
        'upper_arm.L': [(1, A((X, 0.0))), (10, A((X, -1.35), (Y, -0.2))), (36, A((X, -1.35), (Y, -0.2))), (48, A((X, 0.0)))],
        'forearm.L': [(1, A((X, 0.0))), (10, A((X, -0.35))), (36, A((X, -0.35))), (48, A((X, 0.0)))],
        'spine': [(1, A((X, 0.0))), (10, A((X, -0.06))), (36, A((X, -0.06))), (48, A((X, 0.0)))],
    }, loop=False)
    action(rig, 'summon', 40, {
        'upper_arm.L': [(1, A((X, 0.0))), (14, A((X, -2.75), (Y, -0.25))), (40, A((X, -2.75), (Y, -0.25)))],
        'forearm.L': [(1, A((X, 0.0))), (14, A((X, -0.25))), (40, A((X, -0.25)))],
        'upper_arm.R': [(1, A((X, 0.0))), (14, A((X, -1.2))), (40, A((X, -1.2)))],
        'forearm.R': [(1, A((X, 0.0))), (14, A((X, 1.2))), (40, A((X, 1.2)))],
        'head': [(1, A((X, 0.0))), (14, A((X, -0.3))), (40, A((X, -0.3)))],
        'spine': [(1, A((X, 0.0))), (14, A((X, -0.06))), (40, A((X, -0.06)))],
    }, loop=False)
    for pb in rig.pose.bones:
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)


def build():
    crew.PARTS.clear()
    rig = crew.skeleton(BONES, 'odin_rig', 'odin')
    body()
    head()
    gungnir()
    huginn()
    return rig
