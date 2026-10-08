"""Shared helpers for Deepanvil's procedural Blender assets.

Coordinates: everything is *authored in three.js space* (x right, y up, z toward
the camera) via P(), and converted to Blender's z-up space here, so layout numbers
match the client code. A yaw about three's +y equals a yaw about Blender's +z.
"""
import math
import random

import bmesh
import bpy
from mathutils import Matrix, Vector, noise

rng = random.Random(42)


def P(x: float, y: float, z: float) -> Vector:
    """three.js (x, y-up, z) -> Blender (x, y, z-up)."""
    return Vector((x, -z, y))


def hexcol(h: str) -> tuple:
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def reset() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    rng.seed(42)


# --------------------------------------------------------------------------- materials

_MATS: dict = {}

# Materials are just tags for the client: 'paint' = vertex-colored toon,
# 'glow_*' = emissive (bloom), 'gold'/'water' = special shading.
MAT_EMISSION = {
    'glow_ember': ('#ff8a2a', 3.0),
    'glow_crystal': ('#7fe8ff', 2.4),
    'glow_sky': ('#dff1ff', 4.0),
    'glow_lamp': ('#ffc46b', 2.6),
    'glow_mushroom': ('#9dff8a', 1.6),
}


def material(name: str) -> bpy.types.Material:
    if name in _MATS:
        return _MATS[name]
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    if name in MAT_EMISSION and bsdf:
        col, strength = MAT_EMISSION[name]
        bsdf.inputs['Emission Color'].default_value = (*hexcol(col), 1)
        bsdf.inputs['Emission Strength'].default_value = strength
    _MATS[name] = m
    return m


# --------------------------------------------------------------------------- bmesh shapes
# All shape builders return a fresh BMesh with its base at z=0 (unless noted).

def _fresh() -> bmesh.types.BMesh:
    return bmesh.new()


def xform(bm, mat: Matrix) -> bmesh.types.BMesh:
    bmesh.ops.transform(bm, matrix=mat, verts=bm.verts)
    return bm


def move(bm, x=0.0, y=0.0, z=0.0):
    return xform(bm, Matrix.Translation((x, y, z)))


def rot(bm, rx=0.0, ry=0.0, rz=0.0):
    return xform(bm, Matrix.Rotation(rz, 4, 'Z') @ Matrix.Rotation(ry, 4, 'Y') @ Matrix.Rotation(rx, 4, 'X'))


def scale(bm, sx, sy=None, sz=None):
    sy = sx if sy is None else sy
    sz = sx if sz is None else sz
    return xform(bm, Matrix.Diagonal((sx, sy, sz, 1)))


def bevel(bm, offset=0.04, segments=2):
    bmesh.ops.bevel(bm, geom=list(bm.edges) + list(bm.verts), offset=offset, segments=segments,
                    affect='EDGES', profile=0.6, clamp_overlap=True)
    return bm


def box(sx, sy, sz, bev=0.04, seg=2):
    bm = _fresh()
    bmesh.ops.create_cube(bm, size=1.0)
    scale(bm, sx, sy, sz)
    if bev > 0:
        bevel(bm, bev, seg)
    return move(bm, z=sz / 2)


def cyl(r1, r2, h, seg=12, bev=0.0, cap=True):
    bm = _fresh()
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=seg, radius1=r1, radius2=r2, depth=h)
    if bev > 0:
        bevel(bm, bev, 1)
    return move(bm, z=h / 2)


def ball(r, sub=2):
    bm = _fresh()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)
    return bm


def uvball(r, u=16, v=10):
    bm = _fresh()
    bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=r)
    return bm


def subdivide(bm, cuts=1):
    bmesh.ops.subdivide_edges(bm, edges=bm.edges, cuts=cuts, use_grid_fill=True)
    return bm


def wobble(bm, amount=0.03, freq=2.0, seed=0.0):
    """Hand-made irregularity: displace every vertex by a smooth noise vector."""
    off = Vector((seed * 13.1, seed * 7.7, seed * 3.3))
    for v in bm.verts:
        v.co += noise.noise_vector(v.co * freq + off) * amount
    return bm


def smooth_by_angle(bm, angle=0.7):
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        if not e.is_manifold or e.calc_face_angle(math.pi) > angle:
            e.smooth = False
    return bm


def flat(bm):
    for f in bm.faces:
        f.smooth = False
    return bm


def merge(*bms):
    """Concatenate several BMeshes into the first one."""
    out = bms[0]
    for other in bms[1:]:
        me = bpy.data.meshes.new('_tmp')
        other.to_mesh(me)
        other.free()
        out.from_mesh(me)
        bpy.data.meshes.remove(me)
    return out


# --------------------------------------------------------------------------- objects

STATIC: list = []   # objects that get painted and joined
NAMED: list = []    # objects the client animates/looks up by name (kept separate)


def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


def make(name, bm, color, mat='paint', matrix=None, keep=False, ao=True):
    """Create a mesh object from a BMesh. color = '#hex' base paint color."""
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material(mat))
    ob = link(bpy.data.objects.new(name, me))
    if matrix is not None:
        ob.matrix_world = matrix
    ob['base'] = color
    ob['ao'] = ao
    (NAMED if keep else STATIC).append(ob)
    return ob


class Prop:
    """A placed group of parts. Parts are authored in local Blender coords (z-up)."""

    def __init__(self, name, at, yaw=0.0, scale_=1.0, keep=False):
        self.name = name
        self.keep = keep
        self.m = Matrix.Translation(at) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Diagonal((scale_, scale_, scale_, 1))
        self.n = 0

    def part(self, bm, color, mat='paint', at=(0, 0, 0), rx=0.0, ry=0.0, rz=0.0, name=None, keep=None, ao=True):
        self.n += 1
        local = Matrix.Translation(at) @ (Matrix.Rotation(rz, 4, 'Z') @ Matrix.Rotation(ry, 4, 'Y') @ Matrix.Rotation(rx, 4, 'X'))
        return make(name or f'{self.name}_{self.n}', bm, color, mat, self.m @ local,
                    keep=self.keep if keep is None else keep, ao=ao)

    def world(self, x, y, z) -> Vector:
        return self.m @ Vector((x, y, z))


def anchor(name, at: Vector, yaw=0.0, **props):
    """An empty the client reads for placement (dwarf spots, lights, sky hole...)."""
    e = link(bpy.data.objects.new(f'anchor_{name}', None))
    e.empty_display_type = 'ARROWS'
    e.matrix_world = Matrix.Translation(at) @ Matrix.Rotation(yaw, 4, 'Z')
    for k, v in props.items():
        e[k] = v
    return e


def yaw_to(src: Vector, dst: Vector) -> float:
    """Blender yaw so that local -Y ("front") of an object at src faces dst."""
    d = dst - src
    return math.atan2(d.y, d.x) + math.pi / 2
