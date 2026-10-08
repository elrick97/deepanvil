"""Where everything stands, in three.js coordinates (x right, y up, z toward camera).
The client reads the exported anchors, so this file is the single source of layout truth.
"""
import math

FURNACE = (0.0, 0.0, -9.0)
SKY_DIR_PRE = (1.5, 4.0, 13.0 / 0.58)   # Blender-space direction to the sky hole, before dome squash
SUN_SPOT = (-4.5, 0.0, 3.5)             # where the beam lands: the little garden
FLOOR_CENTER = (0.0, 0.0, -3.0)          # centre of the radial flagstones

CAVE_RADIUS = 24.0
CAVE_SQUASH = 0.58


def anvil_spots(n=4, radius=9.0):
    """Anvils on a gentle arc in front of the furnace; returns three-space (x, z)."""
    out = []
    for i in range(n):
        a = math.pi * (0.32 + (i / max(1, n - 1)) * 0.36)
        out.append((FURNACE[0] + math.cos(a) * radius, FURNACE[2] + math.sin(a) * radius))
    return out


MASTER_TABLE = (-11.0, 0.0, -2.0)
LIBRARY = (-14.5, 0.0, -9.5)
QUEST_BOARD = (-9.5, 0.0, 5.5)
TREASURY = (11.0, 0.0, -3.0)
BELL = (13.5, 0.0, 3.0)
CART = (9.0, 0.0, 6.5)
TUNNEL = (20.5, 0.0, -4.0)
VAULT = (10.0, 0.0, -15.0)              # the Vault of Main, back wall right of the furnace
VAULT_FACES = (4.0, 0.0, -6.0)           # the door looks out over the hall towards here
