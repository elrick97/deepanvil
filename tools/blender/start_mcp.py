# Opens Blender with the MCP socket already listening (localhost:9876).
# Usage: blender --python tools/blender/start_mcp.py
import bpy

def _start():
    try:
        bpy.ops.blendermcp.start_server()
        print("DEEPANVIL: blender-mcp socket started")
    except Exception as e:  # add-on missing or already running
        print("DEEPANVIL: could not start blender-mcp:", e)
    return None  # run once

bpy.app.timers.register(_start, first_interval=1.0)
