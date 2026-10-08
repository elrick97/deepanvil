"""The forge's gold coin: one model, two outputs.

- apps/client/public/assets/coin.glb — the coin that flies from the treasury
- apps/client/public/assets/coin.png — a rendered 3/4 icon for the HUD (transparent)

Usage (from the repo root): npm run assets:coin
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

from forge import common, paint  # noqa: E402
from forge.shapes import lathe, prism  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT_DIR = os.path.join(ROOT, 'apps', 'client', 'public', 'assets')
GOLD = '#f2b93b'

# Side profile of an anvil (x, z), traced clockwise from the foot. Embossed on both faces.
ANVIL = [(-0.42, -0.34), (0.42, -0.34), (0.36, -0.26), (0.16, -0.2), (0.12, 0.02), (0.5, 0.08), (0.62, 0.22),
         (-0.3, 0.22), (-0.46, 0.14), (-0.62, 0.1), (-0.34, 0.06), (-0.14, 0.02), (-0.16, -0.2), (-0.36, -0.26)]


def coin() -> bpy.types.Object:
    R, T = 1.0, 0.16
    # Body with a raised rim: revolve a profile around Z (faces are ±Z).
    body = lathe([(0.0, -T * 0.32), (0.84, -T * 0.32), (0.86, -T / 2), (R, -T / 2), (R, T / 2), (0.86, T / 2), (0.84, T * 0.32), (0.0, T * 0.32)], seg=48)
    parts = [body]
    for side in (1, -1):
        emblem = prism([(x * 0.88, z * 0.88) for x, z in ANVIL][::-1 if side > 0 else 1], 0.07)
        bmesh.ops.recalc_face_normals(emblem, faces=emblem.faces)
        common.bevel(emblem, 0.012, 1)
        common.move(emblem, 0, 0, T * 0.32 if side > 0 else -T * 0.32 - 0.07)
        parts.append(emblem)
        for k in range(16):  # a ring of little struck dots
            a = 2 * math.pi * k / 16
            dot = common.ball(0.04, 1)
            common.move(dot, math.cos(a) * 0.76, math.sin(a) * 0.76, side * T * 0.32)
            parts.append(dot)
    bm = common.merge(*parts)
    common.smooth_by_angle(bm, 0.5)
    ob = common.make('coin', bm, GOLD, mat='gold')
    return ob


def render_icon(ob: bpy.types.Object, path: str, size: int = 128) -> None:
    scene = bpy.context.scene
    try:
        scene.render.engine = 'BLENDER_EEVEE'
    except TypeError:
        scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.view_settings.view_transform = 'Standard'

    # A shiny painted gold: vertex AO times a warm metal with a little glow.
    mat = ob.data.materials[0]
    nodes = mat.node_tree.nodes
    bsdf = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
    attr = nodes.new('ShaderNodeVertexColor')
    attr.layer_name = 'Col'
    mix = nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.blend_type = 'MULTIPLY'
    mix.inputs['Factor'].default_value = 1.0
    mix.inputs['A'].default_value = (*common.hexcol('#e8a628'), 1)
    mat.node_tree.links.new(attr.outputs['Color'], mix.inputs['B'])
    mat.node_tree.links.new(mix.outputs['Result'], bsdf.inputs['Base Color'])
    bsdf.inputs['Metallic'].default_value = 0.35
    bsdf.inputs['Roughness'].default_value = 0.45
    bsdf.inputs['Emission Color'].default_value = (*common.hexcol('#ffb020'), 1)
    bsdf.inputs['Emission Strength'].default_value = 0.05

    world = bpy.data.worlds.new('icon') if not scene.world else scene.world
    scene.world = world
    world.color = (0.12, 0.09, 0.07)

    ob.rotation_euler = (math.radians(68), 0, math.radians(-18))  # a jaunty 3/4 tilt
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = 2.35
    cam.location = (0, -6, 0)
    cam.rotation_euler = (math.radians(90), 0, 0)
    scene.collection.objects.link(cam)
    scene.camera = cam
    for name, loc, energy, color in (('key', (-3, -4, 4), 1400, '#fff1d6'), ('rim', (4, 3, 2), 700, '#ff9a3c'), ('fill', (3, -5, -2), 120, '#cfe2ff')):
        light = bpy.data.objects.new(name, bpy.data.lights.new(name, 'POINT'))
        light.data.energy = energy
        light.data.color = common.hexcol(color)
        light.location = loc
        scene.collection.objects.link(light)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def strip_png_metadata(path: str) -> None:
    """Drop Blender's render stamps (date, scene, EXIF) so published images carry no metadata."""
    import struct
    data = open(path, 'rb').read()
    out, i = [data[:8]], 8
    while i < len(data):
        n, = struct.unpack('>I', data[i:i + 4])
        if data[i + 4:i + 8] not in (b'tEXt', b'iTXt', b'zTXt', b'eXIf'):
            out.append(data[i:i + 12 + n])
        i += 12 + n
    open(path, 'wb').write(b''.join(out))


def main():
    common.reset()
    common.STATIC.clear()
    common._MATS.clear()
    ob = coin()
    paint.paint([ob], paint.scene_bvh([ob]), rays=24, reach=0.25)
    os.makedirs(OUT_DIR, exist_ok=True)

    bpy.ops.export_scene.gltf(
        filepath=os.path.join(OUT_DIR, 'coin.glb'), export_format='GLB', export_yup=True,
        export_vertex_color='ACTIVE', export_all_vertex_colors=False, export_materials='EXPORT',
        export_normals=True, export_texcoords=False,
    )
    render_icon(ob, os.path.join(OUT_DIR, 'coin.png'))
    # Home-screen icons: the coin on an opaque forge-dark background (iOS needs opaque).
    scene = bpy.context.scene
    scene.render.film_transparent = False
    bg = next((n for n in scene.world.node_tree.nodes if n.type == 'BACKGROUND'), None) if scene.world.use_nodes else None
    if bg:
        bg.inputs['Color'].default_value = (0.2, 0.075, 0.025, 1)
    else:
        scene.world.color = (0.2, 0.075, 0.025)
    scene.camera.data.ortho_scale = 2.9  # safe margin for rounded-corner masks
    for name, size in (('icon-512.png', 512), ('icon-192.png', 192), ('apple-touch-icon.png', 180)):
        scene.render.resolution_x = scene.render.resolution_y = size
        scene.render.image_settings.color_mode = 'RGB'
        scene.render.filepath = os.path.join(ROOT, 'apps', 'client', 'public', name)
        bpy.ops.render.render(write_still=True)
        strip_png_metadata(scene.render.filepath)
    strip_png_metadata(os.path.join(OUT_DIR, 'coin.png'))
    print('[coin] wrote coin.glb, coin.png and app icons')


main()
