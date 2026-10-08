# Enables the blender-mcp add-on and saves preferences.
# Install the add-on itself first (it is not vendored in this repo):
#   uvx mcp-for-blender==2.1.9 install-addon
# then: blender --background --python tools/blender/install_addon.py
import bpy

for name in ("blender_mcp_addon", "addon", "mcp_for_blender"):
    try:
        bpy.ops.preferences.addon_enable(module=name)
        bpy.ops.wm.save_userpref()
        print("DEEPANVIL: blender-mcp enabled as", name)
        break
    except Exception:  # module name differs between add-on releases
        continue
else:
    print("DEEPANVIL: blender-mcp add-on not found — run `uvx mcp-for-blender==2.1.9 install-addon` first")
