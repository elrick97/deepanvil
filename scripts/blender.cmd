@echo off
rem Launch Blender with the blender-mcp socket running, for Claude's asset work.
start "" "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --python "%~dp0..\tools\blender\start_mcp.py"
