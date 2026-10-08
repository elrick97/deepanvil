"""The dwarf crew: one shared toy-proportioned body on a compact game skeleton.

- Every part is rigidly bound to a single bone (articulated "toy" look, robust export).
- Colour comes from material *slots* (tunic, beard, skin...) that the client recolours per
  dwarf; vertex colours only carry painted shading (AO, warm tops, brush noise).
- Swappable variants (hats, beards, apron, tools) are separate skinned meshes.
- Actions are keyframed per bone and exported as named glTF animations via NLA tracks.

Blender space: the dwarf faces -Y (which becomes three.js +Z), right hand on -X.
"""
import math

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector

from .common import ball, box, cyl, link, material, move, rot, scale, smooth_by_angle, uvball, wobble
from .shapes import lathe

FPS = 24
PARTS: list = []   # (object, bone) to be skinned


# --------------------------------------------------------------------------- skeleton

BONES = [
    # name, head, tail, parent
    ('root', (0, 0, 0), (0, 0, 0.3), None),
    ('hips', (0, 0, 0.42), (0, 0, 0.62), 'root'),
    ('spine', (0, 0, 0.62), (0, 0, 1.02), 'hips'),
    ('head', (0, 0, 1.04), (0, 0, 1.5), 'spine'),
    ('upper_arm.L', (0.43, 0, 0.98), (0.43, 0, 0.72), 'spine'),
    ('forearm.L', (0.43, 0, 0.72), (0.43, 0, 0.5), 'upper_arm.L'),
    ('hand.L', (0.43, 0, 0.5), (0.43, 0, 0.38), 'forearm.L'),
    ('upper_arm.R', (-0.43, 0, 0.98), (-0.43, 0, 0.72), 'spine'),
    ('forearm.R', (-0.43, 0, 0.72), (-0.43, 0, 0.5), 'upper_arm.R'),
    ('hand.R', (-0.43, 0, 0.5), (-0.43, 0, 0.38), 'forearm.R'),
    ('leg.L', (0.15, 0, 0.42), (0.15, 0, 0.05), 'hips'),
    ('leg.R', (-0.15, 0, 0.42), (-0.15, 0, 0.05), 'hips'),
]


def skeleton():
    arm = bpy.data.armatures.new('dwarf_rig')
    rig = link(bpy.data.objects.new('dwarf', arm))
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    for name, head, tail, parent in BONES:
        b = arm.edit_bones.new(name)
        b.head, b.tail = head, tail
        if parent:
            b.parent = arm.edit_bones[parent]
            b.use_connect = False
    bpy.ops.object.mode_set(mode='OBJECT')
    return rig


# --------------------------------------------------------------------------- parts

def part(name, bm, slot, bone, at=(0, 0, 0), rx=0.0, ry=0.0, rz=0.0, smooth=0.9, variant=None):
    if smooth is not None:
        smooth_by_angle(bm, smooth)
    m = Matrix.Translation(at) @ (Matrix.Rotation(rz, 4, 'Z') @ Matrix.Rotation(ry, 4, 'Y') @ Matrix.Rotation(rx, 4, 'X'))
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material(slot))
    ob = link(bpy.data.objects.new(name, me))
    ob['base'] = '#f4f1ec' if slot != 'eyes' else '#2a1c18'
    ob['ao'] = True
    ob['variant'] = variant or 'body'
    PARTS.append((ob, bone))
    return ob


def body():
    for side, x in (('L', 0.15), ('R', -0.15)):
        boot = box(0.22, 0.32, 0.14, bev=0.05)
        part(f'boot.{side}', boot, 'leather', f'leg.{side}', at=(x, -0.04, 0))
        part(f'leg.{side}', cyl(0.12, 0.11, 0.34, seg=10), 'trousers', f'leg.{side}', at=(x, 0, 0.1))
    torso = lathe([(0.0, 0.36), (0.34, 0.36), (0.41, 0.52), (0.42, 0.7), (0.37, 0.92), (0.24, 1.04), (0.0, 1.07)], seg=18)
    scale(torso, 1.0, 0.88, 1.0)
    part('torso', torso, 'tunic', 'spine')
    belt = lathe([(0.425, 0), (0.435, 0.02), (0.435, 0.09), (0.425, 0.11)], seg=24, cap_bottom=False, cap_top=False)
    scale(belt, 1.0, 0.89, 1.0)
    part('belt', belt, 'leather', 'spine', at=(0, 0, 0.5))
    part('buckle', box(0.13, 0.04, 0.11, bev=0.015), 'metal', 'spine', at=(0, -0.385, 0.5))
    for side, x, bone in (('L', 0.43, 'L'), ('R', -0.43, 'R')):
        part(f'shoulder.{side}', ball(0.14, 2), 'tunic', f'upper_arm.{bone}', at=(x, 0, 0.95))
        part(f'upper_arm.{side}', cyl(0.105, 0.1, 0.28, seg=10), 'tunic', f'upper_arm.{bone}', at=(x, 0, 0.7))
        part(f'forearm.{side}', cyl(0.095, 0.085, 0.24, seg=10), 'tunic', f'forearm.{bone}', at=(x, 0, 0.48))
        part(f'cuff.{side}', cyl(0.105, 0.105, 0.05, seg=12), 'leather', f'forearm.{bone}', at=(x, 0, 0.5))
        mitt = ball(0.11, 2)
        scale(mitt, 0.9, 1.0, 1.1)
        part(f'hand.{side}', mitt, 'skin', f'hand.{bone}', at=(x, -0.02, 0.43))
    # Head.
    head = uvball(0.27, 20, 14)
    part('head', head, 'skin', 'head', at=(0, 0, 1.24))
    nose = ball(0.095, 2)
    scale(nose, 1.0, 0.9, 0.95)
    part('nose', nose, 'skin', 'head', at=(0, -0.27, 1.21))
    for side, x in (('L', 0.27), ('R', -0.27)):
        ear = ball(0.07, 1)
        scale(ear, 0.6, 1.0, 1.2)
        part(f'ear.{side}', ear, 'skin', 'head', at=(x, 0, 1.24))
    for side, x in (('L', 0.095), ('R', -0.095)):
        part(f'eye.{side}', ball(0.038, 1), 'eyes', 'head', at=(x, -0.245, 1.255))
        brow = box(0.12, 0.05, 0.045, bev=0.015)
        part(f'brow.{side}', brow, 'beard', 'head', at=(x, -0.24, 1.3), ry=0.18 if x > 0 else -0.18)


def beards():
    # Long: a big soft teardrop from the cheeks down over the belly.
    long_ = lathe([(0.0, -0.5), (0.1, -0.44), (0.2, -0.3), (0.25, -0.12), (0.25, 0.04), (0.2, 0.12), (0.0, 0.14)], seg=16)
    scale(long_, 1.15, 0.72, 1.0)
    wobble(long_, 0.015, 6, 3)
    part('beard_long', long_, 'beard', 'head', at=(0, -0.18, 1.08), rx=-0.12, variant='beard_long')
    # Braids: a shorter mass plus two plaited braids.
    short = lathe([(0.0, -0.22), (0.18, -0.16), (0.25, -0.03), (0.24, 0.08), (0.0, 0.13)], seg=16)
    scale(short, 1.15, 0.75, 1.0)
    part('beard_braids', short, 'beard', 'head', at=(0, -0.18, 1.08), variant='beard_braids')
    for x in (-0.09, 0.09):
        for k in range(4):
            bead = ball(0.05 - k * 0.004, 1)
            scale(bead, 1.0, 1.0, 1.25)
            part(f'braid_{x}_{k}', bead, 'beard', 'head', at=(x, -0.25, 0.86 - k * 0.09), variant='beard_braids')
        part(f'braid_ring_{x}', cyl(0.035, 0.035, 0.04, seg=10), 'metal', 'head', at=(x, -0.25, 0.53), variant='beard_braids')
    # Bushy: wide and round.
    bushy = ball(0.3, 2)
    scale(bushy, 1.25, 0.75, 0.95)
    wobble(bushy, 0.03, 5, 9)
    part('beard_bushy', bushy, 'beard', 'head', at=(0, -0.16, 0.94), variant='beard_bushy')
    # A moustache on every beard.
    for variant in ('beard_long', 'beard_braids', 'beard_bushy'):
        for x, rz in ((0.09, -0.35), (-0.09, 0.35)):
            m = ball(0.07, 1)
            scale(m, 1.6, 0.8, 0.7)
            part(f'stache_{variant}_{x}', m, 'beard', 'head', at=(x, -0.29, 1.14), rz=rz, variant=variant)


def hats():
    helm = uvball(0.295, 18, 12)
    bmesh.ops.delete(helm, geom=[v for v in helm.verts if v.co.z < -0.02], context='VERTS')
    part('hat_helmet', helm, 'metal', 'head', at=(0, 0.02, 1.33), variant='hat_helmet')
    rim = lathe([(0.29, 0), (0.31, 0.01), (0.31, 0.05), (0.29, 0.06)], seg=22, cap_bottom=False, cap_top=False)
    part('hat_helmet_rim', rim, 'metal', 'head', at=(0, 0.02, 1.32), variant='hat_helmet')
    part('hat_helmet_guard', box(0.05, 0.03, 0.1, bev=0.01), 'metal', 'head', at=(0, -0.29, 1.27), variant='hat_helmet')
    part('hat_helmet_spike', cyl(0.04, 0.0, 0.12, seg=8), 'metal', 'head', at=(0, 0.02, 1.61), variant='hat_helmet')

    hood = lathe([(0.31, 0.0), (0.3, 0.12), (0.22, 0.32), (0.1, 0.52), (0.0, 0.62)], seg=16)
    part('hat_hood', hood, 'hat', 'head', at=(0, 0.06, 1.3), rx=0.22, variant='hat_hood')

    cap = lathe([(0.29, 0.0), (0.29, 0.06), (0.25, 0.16), (0.12, 0.22), (0.0, 0.23)], seg=18)
    part('hat_cap', cap, 'hat', 'head', at=(0, 0.02, 1.36), variant='hat_cap')
    part('hat_cap_brim', cyl(0.2, 0.2, 0.03, seg=14), 'hat', 'head', at=(0, -0.22, 1.38), rx=0.25, variant='hat_cap')

    # The Forgemaster's tall fur-trimmed hat.
    tall = lathe([(0.27, 0.0), (0.26, 0.3), (0.22, 0.48), (0.0, 0.5)], seg=18)
    part('hat_master', tall, 'hat', 'head', at=(0, 0.02, 1.4), variant='hat_master')
    fur = lathe([(0.3, 0.0), (0.34, 0.04), (0.34, 0.12), (0.3, 0.15)], seg=22, cap_bottom=False, cap_top=False)
    wobble(fur, 0.012, 9, 4)
    part('hat_master_fur', fur, 'beard', 'head', at=(0, 0.02, 1.35), variant='hat_master')
    part('hat_master_gem', ball(0.045, 1), 'glow_crystal', 'head', at=(0, -0.3, 1.45), variant='hat_master')


def gear():
    apron = box(0.48, 0.05, 0.52, bev=0.02)
    for v in apron.verts:
        v.co.y -= (0.5 - abs(v.co.x) / 0.48) * 0.06  # curve around the belly
    part('apron', apron, 'leather', 'spine', at=(0, -0.41, 0.42), variant='apron')
    # Smith's hammer in the right hand, head forward.
    handle = cyl(0.025, 0.025, 0.5, seg=8)
    part('hammer_handle', handle, 'wood', 'hand.R', at=(-0.43, 0.02, 0.43), rx=math.pi / 2, variant='hammer')
    part('hammer_head', box(0.12, 0.12, 0.24, bev=0.02), 'metal', 'hand.R', at=(-0.43, -0.48, 0.31), variant='hammer')
    # The Forgemaster's rolled blueprint.
    part('scroll', cyl(0.045, 0.045, 0.42, seg=10), 'parchment', 'hand.L', at=(0.43, 0.19, 0.44), rx=math.pi / 2, variant='scroll')


# --------------------------------------------------------------------------- skinning

def skin(rig):
    for ob, bone in PARTS:
        vg = ob.vertex_groups.new(name=bone)
        vg.add(list(range(len(ob.data.vertices))), 1.0, 'REPLACE')
    # Join per variant so the client toggles whole pieces (body, hat_helmet, ...).
    groups: dict = {}
    for ob, _ in PARTS:
        groups.setdefault(ob['variant'], []).append(ob)
    meshes = []
    for variant, obs in groups.items():
        ctx = bpy.context
        for o in ctx.view_layer.objects:
            o.select_set(False)
        for o in obs:
            o.select_set(True)
        ctx.view_layer.objects.active = obs[0]
        if len(obs) > 1:
            bpy.ops.object.join()
        ob = obs[0]
        ob.name = ob.data.name = variant
        ob.parent = rig
        mod = ob.modifiers.new('rig', 'ARMATURE')
        mod.object = rig
        meshes.append(ob)
    return meshes


# --------------------------------------------------------------------------- animation

def _q_world(rig, bone, axis_world, angle):
    """A pose rotation about a *world* axis, expressed in the bone's rest frame."""
    rest = rig.data.bones[bone].matrix_local.to_3x3()
    return Quaternion(rest.inverted() @ Vector(axis_world), angle)


X, Y, Z = (1, 0, 0), (0, 1, 0), (0, 0, 1)
# Signs (dwarf faces -Y): bones pointing DOWN (arms, legs) swing forward with -angle about X;
# bones pointing UP (spine, head) lean forward with +angle about X.


def action(rig, name, frames, keys, loop=True):
    """keys: {bone: [(frame, [(axis, angle), ...]), ...]}, plus 'root_z': [(frame, z)]."""
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    rig.animation_data_create()
    rig.animation_data.action = act
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = Quaternion()
        pb.location = (0, 0, 0)
    for bone, track in keys.items():
        if bone == 'root_z':
            pb = rig.pose.bones['root']
            for f, z in track:
                pb.location = (0, z, 0)  # root's local Y is world Z
                pb.keyframe_insert('location', frame=f)
            continue
        pb = rig.pose.bones[bone]
        for f, rots in track:
            q = Quaternion()
            for axis, ang in rots:
                q = _q_world(rig, bone, axis, ang) @ q
            pb.rotation_quaternion = q
            pb.keyframe_insert('rotation_quaternion', frame=f)
    # Every bone gets a key at both ends so clips never inherit another clip's pose.
    for pb in rig.pose.bones:
        if not bone_has_keys(act, pb.name):
            pb.rotation_quaternion = Quaternion()
            for f in (1, frames):
                pb.keyframe_insert('rotation_quaternion', frame=f)
    track = rig.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 1, act)
    strip.extrapolation = 'HOLD' if not loop else 'HOLD_FORWARD'
    rig.animation_data.action = None
    return act


def bone_has_keys(act, bone) -> bool:
    path = f'pose.bones["{bone}"]'
    curves = []
    if hasattr(act, 'fcurves'):
        curves = act.fcurves
    else:  # Blender 5 layered actions
        for layer in act.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    curves = list(curves) + list(bag.fcurves)
    return any(fc.data_path.startswith(path) for fc in curves)


def animations(rig):
    A = lambda *r: list(r)  # noqa: E731
    action(rig, 'idle', 48, {
        'spine': [(1, A((X, 0.0))), (24, A((X, 0.04))), (48, A((X, 0.0)))],
        'head': [(1, A((Z, 0.0))), (16, A((Z, 0.08))), (36, A((Z, -0.06))), (48, A((Z, 0.0)))],
        'upper_arm.L': [(1, A((Y, -0.12))), (24, A((Y, -0.16))), (48, A((Y, -0.12)))],
        'upper_arm.R': [(1, A((Y, 0.12))), (24, A((Y, 0.16))), (48, A((Y, 0.12)))],
        'root_z': [(1, 0.0), (24, -0.012), (48, 0.0)],
    })
    s = 0.5
    action(rig, 'walk', 20, {
        'leg.L': [(1, A((X, -s))), (11, A((X, s))), (20, A((X, -s)))],
        'leg.R': [(1, A((X, s))), (11, A((X, -s))), (20, A((X, s)))],
        'upper_arm.L': [(1, A((X, 0.45))), (11, A((X, -0.45))), (20, A((X, 0.45)))],
        'upper_arm.R': [(1, A((X, -0.45))), (11, A((X, 0.45))), (20, A((X, -0.45)))],
        'spine': [(1, A((Z, 0.06))), (11, A((Z, -0.06))), (20, A((Z, 0.06)))],
        'root_z': [(1, 0.0), (6, 0.05), (11, 0.0), (16, 0.05), (20, 0.0)],
    })
    action(rig, 'hammer', 22, {
        'upper_arm.R': [(1, A((X, -1.05))), (9, A((X, -2.7))), (15, A((X, -2.95))), (19, A((X, -1.0))), (22, A((X, -1.05)))],
        'forearm.R': [(1, A((X, -0.35))), (9, A((X, -0.8))), (15, A((X, -0.9))), (19, A((X, -0.2))), (22, A((X, -0.35)))],
        'upper_arm.L': [(1, A((X, -0.5), (Y, -0.1))), (22, A((X, -0.5), (Y, -0.1)))],
        'forearm.L': [(1, A((X, -0.7))), (22, A((X, -0.7)))],
        'spine': [(1, A((X, 0.12))), (12, A((X, -0.04))), (19, A((X, 0.16))), (22, A((X, 0.12)))],
        'head': [(1, A((X, 0.12))), (19, A((X, 0.18))), (22, A((X, 0.12)))],
    })
    action(rig, 'read', 60, {
        'upper_arm.L': [(1, A((X, -0.7), (Y, 0.25))), (60, A((X, -0.7), (Y, 0.25)))],
        'upper_arm.R': [(1, A((X, -0.7), (Y, -0.25))), (60, A((X, -0.7), (Y, -0.25)))],
        'forearm.L': [(1, A((X, -1.0))), (30, A((X, -1.0))), (38, A((X, -1.3))), (46, A((X, -1.0))), (60, A((X, -1.0)))],
        'forearm.R': [(1, A((X, -1.0))), (60, A((X, -1.0)))],
        'head': [(1, A((X, 0.3))), (20, A((X, 0.32), (Z, 0.08))), (40, A((X, 0.3), (Z, -0.08))), (60, A((X, 0.3)))],
        'spine': [(1, A((X, 0.06))), (60, A((X, 0.06)))],
    })
    action(rig, 'bellows', 30, {
        'upper_arm.L': [(1, A((X, -1.2))), (15, A((X, -0.75))), (30, A((X, -1.2)))],
        'upper_arm.R': [(1, A((X, -1.2))), (15, A((X, -0.75))), (30, A((X, -1.2)))],
        'forearm.L': [(1, A((X, -0.2))), (15, A((X, -0.7))), (30, A((X, -0.2)))],
        'forearm.R': [(1, A((X, -0.2))), (15, A((X, -0.7))), (30, A((X, -0.2)))],
        'spine': [(1, A((X, 0.22))), (15, A((X, 0.05))), (30, A((X, 0.22)))],
    })
    action(rig, 'ring_bell', 24, {
        'upper_arm.R': [(1, A((X, -2.85))), (8, A((X, -2.45))), (16, A((X, -2.85))), (24, A((X, -2.85)))],
        'forearm.R': [(1, A((X, -0.1))), (8, A((X, -0.5))), (16, A((X, -0.1))), (24, A((X, -0.1)))],
        'upper_arm.L': [(1, A((Y, -0.5))), (24, A((Y, -0.5)))],
        'forearm.L': [(1, A((X, -1.2))), (24, A((X, -1.2)))],
        'head': [(1, A((X, -0.2))), (24, A((X, -0.2)))],
    })
    action(rig, 'cheer', 30, {
        'upper_arm.L': [(1, A((X, -0.3))), (8, A((X, -2.9), (Y, -0.3))), (16, A((X, -2.7), (Y, -0.4))), (24, A((X, -2.9), (Y, -0.3))), (30, A((X, -0.3)))],
        'upper_arm.R': [(1, A((X, -0.3))), (8, A((X, -2.9), (Y, 0.3))), (16, A((X, -2.7), (Y, 0.4))), (24, A((X, -2.9), (Y, 0.3))), (30, A((X, -0.3)))],
        'head': [(1, A((X, 0.0))), (10, A((X, -0.25))), (30, A((X, 0.0)))],
        'root_z': [(1, 0.0), (5, -0.05), (10, 0.22), (15, 0.0), (19, 0.12), (23, 0.0), (30, 0.0)],
        'leg.L': [(1, A((X, 0.0))), (10, A((X, -0.25))), (15, A((X, 0.0)))],
        'leg.R': [(1, A((X, 0.0))), (10, A((X, 0.25))), (15, A((X, 0.0)))],
    })
    action(rig, 'slump', 48, {
        'spine': [(1, A((X, 0.3))), (24, A((X, 0.34))), (48, A((X, 0.3)))],
        'head': [(1, A((X, 0.4))), (24, A((X, 0.45), (Z, 0.1))), (48, A((X, 0.4)))],
        'upper_arm.L': [(1, A((X, -0.2))), (48, A((X, -0.2)))],
        'upper_arm.R': [(1, A((X, -0.2))), (48, A((X, -0.2)))],
        'root_z': [(1, -0.03), (48, -0.03)],
    })
    action(rig, 'scratch_beard', 48, {
        'upper_arm.L': [(1, A((X, -1.45), (Y, 0.35))), (48, A((X, -1.45), (Y, 0.35)))],
        'forearm.L': [(1, A((X, -1.55))), (8, A((X, -1.7))), (16, A((X, -1.5))), (24, A((X, -1.7))), (32, A((X, -1.5))), (40, A((X, -1.7))), (48, A((X, -1.55)))],
        'head': [(1, A((X, -0.12), (Z, 0.15))), (48, A((X, -0.12), (Z, 0.15)))],
        'upper_arm.R': [(1, A((Y, 0.12))), (48, A((Y, 0.12)))],
    })
    # Rest pose on frame 1 for the exported bind.
    for pb in rig.pose.bones:
        pb.rotation_quaternion = Quaternion()
        pb.location = (0, 0, 0)


def build():
    PARTS.clear()
    rig = skeleton()
    body()
    beards()
    hats()
    gear()
    return rig
