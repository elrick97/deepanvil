"""Odin, keeper of the Vault of Main (concept model; rigged on the crew skeleton later).

Taller and slimmer than the dwarves (~2.3 m to the hat): a wanderer's cloak and wide hat,
an eye patch and one faintly glowing eye, a long white beard, Gungnir in his right hand,
and his ravens Huginn and Muninn. Faces -Y like the crew; right hand on -X.
"""
import math

from mathutils import Vector

from .common import Prop, ball, box, cyl, rot, scale, smooth_by_angle, uvball, wobble
from .shapes import lathe

CLOAK, CLOAK_IN, TUNIC = '#34405a', '#5a3f2e', '#6f6a78'
SKIN, BEARD, LEATHER, GOLD, IRON = '#e6b896', '#eeeae2', '#5b3b26', '#e2b04a', '#4f4c58'
RAVEN, RUNE = '#1d1f2a', '#9fd8ff'


def raven(p: Prop, at, yaw=0.0, name='raven'):
    r = Prop(name, p.world(*at), yaw=yaw)
    body = uvball(0.13, 12, 8)
    scale(body, 0.8, 1.35, 0.85)
    r.part(smooth_by_angle(body, 1.0), RAVEN, at=(0, 0, 0.1), rx=-0.35)
    r.part(uvball(0.075, 10, 7), RAVEN, at=(0, -0.16, 0.22))
    beak = cyl(0.025, 0.0, 0.1, seg=6)
    rot(beak, math.pi / 2, 0, 0)
    r.part(beak, '#2b2a30', at=(0, -0.23, 0.215))
    for x in (-0.03, 0.03):
        r.part(ball(0.012, 1), RUNE, mat='glow_rune', at=(x, -0.22, 0.24), ao=False)
    tail = box(0.1, 0.18, 0.02, bev=0.005)
    r.part(tail, RAVEN, at=(0, 0.18, 0.04), rx=0.4)
    for side in (-1, 1):
        wing = box(0.035, 0.24, 0.12, bev=0.01)
        r.part(wing, '#262a38', at=(side * 0.1, 0.02, 0.06), rz=side * 0.08)


def build(at: Vector, yaw: float = 0.0):
    o = Prop('odin', at, yaw=yaw)
    # Cloak: a long flared bell from the shoulders to the floor, open at the front.
    cloak = lathe([(0.0, 0.02), (0.62, 0.02), (0.58, 0.4), (0.5, 1.0), (0.44, 1.45), (0.36, 1.62), (0.18, 1.72), (0.0, 1.74)], seg=24)
    scale(cloak, 1.0, 0.82, 1.0)
    for v in cloak.verts:  # cut the front open a little (tunic shows through)
        if v.co.y < -0.3 and v.co.z < 1.5 and abs(v.co.x) < 0.16:
            v.co.y *= 0.82
    wobble(cloak, 0.02, 3, 11)
    o.part(smooth_by_angle(cloak, 0.9), CLOAK)
    tunic = lathe([(0.0, 0.2), (0.3, 0.2), (0.33, 0.9), (0.28, 1.4), (0.0, 1.5)], seg=16)
    o.part(smooth_by_angle(tunic, 0.9), TUNIC, at=(0, -0.12, 0))
    belt = lathe([(0.34, 0), (0.35, 0.02), (0.35, 0.08), (0.34, 0.1)], seg=20, cap_bottom=False, cap_top=False)
    o.part(belt, LEATHER, at=(0, -0.1, 0.95))
    o.part(box(0.1, 0.03, 0.09, bev=0.01), GOLD, at=(0, -0.46, 0.95))
    # Shoulders, mantle and a gold clasp.
    mantle = lathe([(0.44, 0.0), (0.46, 0.05), (0.38, 0.17), (0.2, 0.26), (0.0, 0.28)], seg=20)
    scale(mantle, 1.18, 0.78, 1.0)
    wobble(mantle, 0.025, 6, 12)  # shaggy fur
    o.part(smooth_by_angle(mantle, 0.9), CLOAK_IN, at=(0, 0, 1.5))
    o.part(ball(0.06, 2), GOLD, at=(0.0, -0.4, 1.62))
    # Arms: right holds Gungnir upright at his side, left rests on the belt.
    for side in (-1, 1):
        sleeve = cyl(0.11, 0.14, 0.56, seg=10)  # tops tuck under the mantle
        o.part(smooth_by_angle(sleeve, 0.8), CLOAK, at=(side * 0.45, 0, 1.0), ry=side * 0.1)
    o.part(ball(0.085, 2), SKIN, at=(-0.56, -0.1, 0.98))
    o.part(ball(0.08, 2), SKIN, at=(0.56, -0.08, 0.98))
    # Head, eye patch, the glowing eye, brows.
    o.part(uvball(0.21, 18, 12), SKIN, at=(0, -0.05, 1.93))
    nose = ball(0.07, 2)
    scale(nose, 0.8, 1.0, 1.1)
    o.part(nose, SKIN, at=(0, -0.26, 1.9))
    patch = cyl(0.065, 0.065, 0.025, seg=12)
    rot(patch, math.pi / 2, 0, 0)
    o.part(patch, '#1f1a1a', at=(-0.08, -0.23, 1.98))
    strap = lathe([(0.215, 0), (0.218, 0.005), (0.218, 0.025), (0.215, 0.03)], seg=24, cap_bottom=False, cap_top=False)
    o.part(strap, '#1f1a1a', at=(0, -0.05, 1.96), ry=-0.25)
    o.part(ball(0.03, 1), RUNE, mat='glow_rune', at=(0.08, -0.235, 1.985), ao=False)
    for x in (-0.08, 0.08):
        brow = box(0.12, 0.05, 0.04, bev=0.015)
        o.part(brow, BEARD, at=(x, -0.22, 2.04), ry=0.15 if x > 0 else -0.15)
    # A long white beard down to the belt, and a moustache.
    beard = lathe([(0.0, -0.9), (0.08, -0.82), (0.18, -0.55), (0.23, -0.25), (0.22, 0.0), (0.17, 0.1), (0.0, 0.13)], seg=16)
    scale(beard, 0.85, 0.62, 0.95)
    wobble(beard, 0.02, 5, 13)
    o.part(smooth_by_angle(beard, 1.0), BEARD, at=(0, -0.33, 1.77), rx=-0.14)  # from the chin, down over the mantle
    for x, rz in ((0.08, -0.45), (-0.08, 0.45)):
        m = ball(0.07, 1)
        scale(m, 1.7, 0.8, 0.7)
        o.part(m, BEARD, at=(x, -0.27, 1.85), rz=rz)
    # The wanderer's hat: wide brim, slouched crown.
    brim = cyl(0.46, 0.46, 0.03, seg=28)
    wobble(brim, 0.015, 3, 14)
    o.part(smooth_by_angle(brim, 1.0), '#2c3448', at=(0, -0.04, 2.08), rx=0.1)
    crown = lathe([(0.21, 0.0), (0.2, 0.18), (0.14, 0.32), (0.05, 0.38), (0.0, 0.38)], seg=18)
    for v in crown.verts:
        v.co.y += (v.co.z / 0.38) ** 2 * 0.08  # slouches backwards
    o.part(smooth_by_angle(crown, 0.9), '#2c3448', at=(0, -0.02, 2.1), rx=0.1)
    o.part(lathe([(0.212, 0), (0.215, 0.01), (0.215, 0.06), (0.212, 0.07)], seg=20, cap_bottom=False, cap_top=False), LEATHER, at=(0, -0.02, 2.11), rx=0.1)
    # Gungnir: an ash shaft with a rune-lit blade.
    spear = Prop('gungnir', o.world(-0.62, -0.12, 0), yaw=yaw)
    spear.part(cyl(0.035, 0.03, 2.55, seg=8), '#8a5a36', name='gungnir_shaft')
    spear.part(cyl(0.05, 0.05, 0.12, seg=8), GOLD, at=(0, 0, 2.5), name='gungnir_collar')
    blade = lathe([(0.0, 0.0), (0.075, 0.1), (0.06, 0.35), (0.0, 0.52)], seg=4)
    scale(blade, 1.0, 0.35, 1.0)
    spear.part(blade, RUNE, mat='glow_rune', at=(0, 0, 2.6), name='gungnir_blade', ao=False)
    # Huginn on his shoulder; Muninn waits on the scales post (placed by the caller).
    raven(o, (0.42, 0.05, 1.68), yaw=0.3, name='huginn')
    return o


def raven_at(at: Vector, yaw=0.0, name='muninn'):
    holder = Prop(name + '_perch', at)
    raven(holder, (0, 0, 0), yaw=yaw, name=name)
