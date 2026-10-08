"""Painterly vertex colouring.

Every static vertex gets: base colour x ambient occlusion (raycast against the whole
scene, so props darken the floor they stand on), a cool shadow tint, a warm "sky
catch" on upward faces, brush-like noise and light edge wear. The client multiplies
this by a stepped toon ramp, which together reads as hand-painted.
"""
import math
import time

import bmesh
import bpy
from mathutils import Matrix, Vector, noise
from mathutils.bvhtree import BVHTree

from .common import hexcol

SHADOW_TINT = Vector((0.36, 0.30, 0.42))   # cool violet-brown in occlusion
WARM_TOP = Vector((1.10, 1.02, 0.86))      # sunlit tops lean warm


def _srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _hemisphere(n: int):
    """Fixed cosine-weighted directions around +Z (deterministic)."""
    dirs = []
    golden = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        r = math.sqrt((i + 0.5) / n)
        a = i * golden
        dirs.append(Vector((r * math.cos(a), r * math.sin(a), math.sqrt(max(0.0, 1 - r * r)))))
    return dirs


def bake_transforms(objs):
    for ob in objs:
        ob.data.transform(ob.matrix_world)
        ob.matrix_world = Matrix.Identity(4)


def scene_bvh(objs) -> BVHTree:
    verts, polys = [], []
    for ob in objs:
        off = len(verts)
        verts.extend(v.co.copy() for v in ob.data.vertices)
        polys.extend([off + i for i in p.vertices] for p in ob.data.polygons)
    return BVHTree.FromPolygons(verts, polys, epsilon=0.0)


def _convexity(me) -> list:
    """Per-vertex convexity (>0 on ridges/edges) for edge-wear highlights."""
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    out = [0.0] * len(bm.verts)
    for v in bm.verts:
        if not v.link_edges:
            continue
        acc = 0.0
        for e in v.link_edges:
            d = e.other_vert(v).co - v.co
            ln = d.length
            if ln > 1e-6:
                acc += -d.dot(v.normal) / ln
        out[v.index] = acc / len(v.link_edges)
    bm.free()
    return out


def paint(objs, bvh: BVHTree, rays=12, reach=2.2):
    dirs = _hemisphere(rays)
    t0 = time.time()
    total = 0
    for ob in objs:
        me = ob.data
        n = len(me.vertices)
        total += n
        base_s = hexcol(ob['base'])
        base = Vector([_srgb_to_linear(c) for c in base_s])
        glowing = me.materials and me.materials[0].name.startswith('glow')
        do_ao = bool(ob.get('ao', True)) and not glowing
        seed = Vector((sum(map(ord, ob.name)) % 97 * 0.37, 1.7, 3.1))  # stable across runs
        convex = _convexity(me) if not glowing else [0.0] * n
        cols = [0.0] * (n * 4)
        for i, v in enumerate(me.vertices):
            co, nrm = v.co, v.normal
            if glowing:
                c = base
            else:
                ao = 1.0
                if do_ao:
                    q = nrm.to_track_quat('Z', 'Y')
                    origin = co + nrm * 0.02
                    occ = 0.0
                    for d in dirs:
                        hit = bvh.ray_cast(origin, q @ d, reach)
                        if hit[0] is not None:
                            occ += 1.0 - (hit[3] / reach) ** 0.7
                    ao = 1.0 - occ / rays
                    ao = ao ** 1.3
                shade = SHADOW_TINT.lerp(Vector((1, 1, 1)), ao)
                c = Vector((base.x * shade.x, base.y * shade.y, base.z * shade.z))
                # Sky catch: faces pointing up pick up warm light.
                up = max(0.0, nrm.z)
                c = c.lerp(Vector((c.x * WARM_TOP.x, c.y * WARM_TOP.y, c.z * WARM_TOP.z)), up)
                # Brush variation: low-frequency value + slight hue drift.
                b = noise.noise(co * 0.9 + seed)
                h = noise.noise_vector(co * 0.35 + seed)
                c = c * (1.0 + 0.16 * b)
                c = Vector((c.x * (1 + 0.05 * h.x), c.y * (1 + 0.04 * h.y), c.z * (1 + 0.06 * h.z)))
                # Edge wear: ridges catch a lighter stroke.
                wear = max(0.0, min(1.0, convex[i] * 2.2))
                c = c.lerp(c * 1.45, wear * 0.55)
            j = i * 4
            cols[j:j + 4] = (max(0.0, c.x), max(0.0, c.y), max(0.0, c.z), 1.0)
        attr = me.color_attributes.get('Col') or me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
        attr.data.foreach_set('color', cols)
        me.color_attributes.active_color = attr
        me.color_attributes.render_color_index = me.color_attributes.find('Col')
    print(f'[paint] {len(objs)} objects, {total} verts, {rays} rays in {time.time() - t0:.1f}s')


def join_by_material(objs, prefix='hall'):
    """Merge painted static parts into one object per material (few draw calls)."""
    by_mat: dict = {}
    for ob in objs:
        by_mat.setdefault(ob.data.materials[0].name, []).append(ob)
    joined = []
    for mat, group in by_mat.items():
        ctx = bpy.context
        for o in ctx.view_layer.objects:
            o.select_set(False)
        for o in group:
            o.select_set(True)
        ctx.view_layer.objects.active = group[0]
        bpy.ops.object.join()
        group[0].name = f'{prefix}_{mat}'
        joined.append(group[0])
    return joined
