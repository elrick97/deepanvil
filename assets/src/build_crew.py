"""Builds the dwarf crew and exports apps/client/public/assets/crew.glb.

Usage (from the repo root): npm run assets:crew
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bpy  # noqa: E402

from forge import common, crew, paint  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'apps', 'client', 'public', 'assets', 'crew.glb')
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def main():
    t0 = time.time()
    common.reset()
    common._MATS.clear()
    bpy.context.scene.render.fps = crew.FPS

    rig = crew.build()
    parts = [ob for ob, _ in crew.PARTS]
    # Variants overlap (three beards on one chin), so AO only sees the body + its own part.
    body = [ob for ob in parts if ob['variant'] == 'body']
    for ob in parts:
        scope = body if ob['variant'] == 'body' else body + [ob]
        paint.paint([ob], paint.scene_bvh(scope), rays=24, reach=0.35)
    meshes = crew.skin(rig)
    crew.animations(rig)
    print(f'[crew] {len(parts)} parts -> {len(meshes)} meshes: {sorted(m.name for m in meshes)}')

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=OUT,
        export_format='GLB',
        export_yup=True,
        export_skins=True,
        export_animation_mode='NLA_TRACKS',
        export_vertex_color='ACTIVE',
        export_all_vertex_colors=False,
        export_materials='EXPORT',
        export_normals=True,
        export_texcoords=False,
        export_cameras=False,
        export_lights=False,
    )
    print(f'[crew] wrote {OUT} ({os.path.getsize(OUT) / 1024:.0f} KB) in {time.time() - t0:.1f}s')
    if '--save' in argv:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, 'assets', 'out', 'crew.blend'))


main()
