"""Concept renders of Odin and the Vault of Main (design review, before integration).

Usage (from the repo root):
  node scripts/run-blender.mjs -b --factory-startup --python assets/src/concept_odin.py
Writes docs/concepts/odin-hero.png and docs/concepts/odin-closeup.png.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

from build_coin import strip_png_metadata  # noqa: E402
from forge import common, odin, paint, vault  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'docs', 'concepts')

GLOW = {
    'glow_rune': ('#6fc6ff', 1.1), 'glow_rune_tests': ('#2ee67a', 1.2), 'glow_rune_types': ('#3f9dff', 1.2),
    'glow_rune_lint': ('#a070ff', 1.2), 'glow_rune_review': ('#ffbf3a', 1.3), 'glow_ember': ('#ff7a1a', 1.6),
}


def backdrop():
    """A rough cave wall behind the door and a stone floor, so the vault reads in context."""
    wall = bmesh.new()
    bmesh.ops.create_grid(wall, x_segments=40, y_segments=30, size=1)
    for v in wall.verts:
        x, z = v.co.x * 8, (v.co.y + 1) * 4
        v.co = Vector((x, 0.55 + common.noise.fractal(Vector((x * 0.4, 0, z * 0.4)), 0.7, 2.0, 4) * 0.6 + max(0, abs(x) - 4) * -0.25, z))
    common.flat(wall)
    common.make('wall', wall, '#8f7a68')
    floor = bmesh.new()
    bmesh.ops.create_grid(floor, x_segments=30, y_segments=30, size=9)
    for v in floor.verts:
        v.co.z = common.noise.fractal(v.co * 0.3, 0.7, 2.0, 3) * 0.05 - 0.01
        v.co.y -= 4
    common.flat(floor)
    common.make('floor', floor, '#b49a7e')


def shade_for_render():
    for m in bpy.data.materials:
        nodes = m.node_tree.nodes
        bsdf = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
        if m.name in GLOW:
            col, strength = GLOW[m.name]
            bsdf.inputs['Base Color'].default_value = (*common.hexcol(col), 1)
            bsdf.inputs['Emission Color'].default_value = (*common.hexcol(col), 1)
            bsdf.inputs['Emission Strength'].default_value = strength
            continue
        attr = nodes.new('ShaderNodeVertexColor')
        attr.layer_name = 'Col'
        m.node_tree.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
        bsdf.inputs['Roughness'].default_value = 0.85
        if m.name == 'gold':
            bsdf.inputs['Metallic'].default_value = 0.6
            bsdf.inputs['Roughness'].default_value = 0.4


def light(name, kind, loc, energy, color, size=0.5):
    ob = common.link(bpy.data.objects.new(name, bpy.data.lights.new(name, kind)))
    ob.data.energy = energy
    ob.data.color = common.hexcol(color)
    ob.location = loc
    if kind == 'SUN':
        ob.rotation_euler = (math.radians(55), 0, math.radians(-35))
        ob.data.angle = math.radians(8)
    else:
        ob.data.shadow_soft_size = size
    return ob


def camera(name, loc, target, lens=35):
    cam = common.link(bpy.data.objects.new(name, bpy.data.cameras.new(name)))
    cam.data.lens = lens
    cam.location = loc
    cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    return cam


def render(cam, path, w, h):
    scene = bpy.context.scene
    scene.camera = cam
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    strip_png_metadata(path)


def main():
    common.reset()
    common.STATIC.clear()
    common.NAMED.clear()
    common._MATS.clear()

    vault.build(Vector((0, 0, 0)))
    odin.build(Vector((-0.6, -3.1, 0.44)))
    odin.raven_at(Vector((1.2, -3.3, 0.44 + 1.56)), yaw=0.6)
    backdrop()

    everything = common.STATIC + common.NAMED
    paint.bake_transforms(common.STATIC)
    for ob in common.NAMED:
        ob.data.transform(ob.matrix_world)
    paint.paint(everything, paint.scene_bvh(everything), rays=24, reach=1.2)
    for ob in common.NAMED:
        ob.data.transform(ob.matrix_world.inverted())
    shade_for_render()

    scene = bpy.context.scene
    try:
        scene.render.engine = 'BLENDER_EEVEE'
    except TypeError:
        pass
    scene.view_settings.view_transform = 'Standard'  # keeps the rune hues saturated (AgX washes them to white)
    world = bpy.data.worlds.new('cave')
    scene.world = world
    bg = next((n for n in world.node_tree.nodes if n.type == 'BACKGROUND'), None)
    if bg:
        bg.inputs['Color'].default_value = (0.05, 0.035, 0.03, 1)
        bg.inputs['Strength'].default_value = 1.0

    light('sun', 'SUN', (0, -10, 10), 2.2, '#fff0d6')
    light('door_glow', 'POINT', (0, -1.6, 2.6), 380, '#9fd8ff', 1.5)
    light('brazier_l', 'POINT', (-2.2, -1.7, 1.9), 160, '#9fd8ff')
    light('brazier_r', 'POINT', (2.2, -1.7, 1.9), 160, '#9fd8ff')
    light('offering', 'POINT', (0.5, -3.6, 1.6), 60, '#ff9a3c')
    light('forge_fill', 'POINT', (3, -9, 3), 900, '#ffb070', 3.0)

    os.makedirs(OUT, exist_ok=True)
    render(camera('hero', (5.8, -11.5, 3.4), (0, -2.0, 2.0), 32), os.path.join(OUT, 'odin-hero.png'), 1280, 720)
    render(camera('closeup', (1.2, -6.4, 2.25), (-0.55, -3.1, 1.75), 55), os.path.join(OUT, 'odin-closeup.png'), 720, 960)
    print('[concept] wrote', OUT)


main()
