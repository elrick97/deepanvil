"""Builds the whole forge-hall and exports apps/client/public/assets/hall.glb.

Usage (from the repo root):
  npm run assets
  # or: blender -b --factory-startup --python assets/src/build.py [-- --rays 12 --save]
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bpy  # noqa: E402

from forge import common, hall, paint, props  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'apps', 'client', 'public', 'assets', 'hall.glb')
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
RAYS = int(argv[argv.index('--rays') + 1]) if '--rays' in argv else 24


def main():
    t0 = time.time()
    common.reset()
    common.STATIC.clear()
    common.NAMED.clear()
    common._MATS.clear()

    hall.build()
    props.build()
    print(f'[build] {len(common.STATIC)} static parts, {len(common.NAMED)} named parts')

    everything = common.STATIC + common.NAMED
    # Static parts get their transforms baked in. Named parts keep a local pivot (the client
    # animates them), so their mesh is temporarily moved to world space for the AO raycasts.
    paint.bake_transforms(common.STATIC)
    for ob in common.NAMED:
        ob.data.transform(ob.matrix_world)
    paint.paint(everything, paint.scene_bvh(everything), rays=RAYS)
    for ob in common.NAMED:
        ob.data.transform(ob.matrix_world.inverted())

    paint.join_by_material(common.STATIC, prefix='hall')

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=OUT,
        export_format='GLB',
        export_yup=True,
        export_apply=True,
        export_vertex_color='ACTIVE',
        export_all_vertex_colors=False,
        export_materials='EXPORT',
        export_extras=True,
        export_normals=True,
        export_texcoords=False,
        export_cameras=False,
        export_lights=False,
    )
    size = os.path.getsize(OUT) / 1024
    tris = 0
    for o in bpy.data.objects:
        if o.type == 'MESH':
            o.data.calc_loop_triangles()
            tris += len(o.data.loop_triangles)
    print(f'[build] wrote {OUT} ({size:.0f} KB, {tris} tris) in {time.time() - t0:.1f}s')
    if '--save' in argv:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, 'assets', 'out', 'hall.blend'))


main()
