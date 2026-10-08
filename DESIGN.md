# Deepanvil — Design Spec

> A painterly, sunlit dwarven forge-hall where your AI coding agents live and work.
> Opus plans, Sonnet smiths code, Haiku sprites keep the place alive — and you watch it all from your desk or your iPhone.

Status: design locked via interview, 2026-10-04. Build order: **beauty first**.

---

## 1. Decisions at a glance

| Area | Decision |
|---|---|
| Engine | Own orchestrator on the **Claude Agent SDK** (TypeScript) |
| Billing | **Claude subscription** (Pro/Max) — treasury shows plan usage, plus "API-equivalent" cost |
| Host | **This Windows PC, inside WSL2 Ubuntu** (already installed) |
| Remote | **Tailscale Serve** private HTTPS (`https://<pc>.<tailnet>.ts.net`) — Tailscale already installed |
| Phone | **iPhone**, full 3D with adaptive quality, installed as PWA for push |
| Art | **Painterly stylized** (hand-painted textures, toon ramp, rim light) |
| Assets | **Mostly procedural in Blender** via blender-mcp, characters auto-rigged with **Rigify** |
| Lighting | **Bright day-lit cavern** — skylight shaft, crystals, warm forge glow vs cool daylight |
| World | **One great forge-hall** diorama, orbit camera |
| Frontend | **Vanilla three.js** (WebGPURenderer, auto WebGL2 fallback) + a tiny UI lib |
| Input | **Forgemaster chat** + **Quest board** |
| Plan gate | **Always approve blueprints** ("Light the forges" button) |
| Routing | **Strict tiers + escalation** |
| Haiku jobs | **Summaries/digests** + **flavor & lore** |
| Scouting | **Forgemaster** puts exact files/snippets into each blueprint task |
| Isolation | **Git worktree per anvil** |
| Scale | **2–4 smiths, one repo at a time** |
| Approvals | **Tiered auto-approve**; risky actions ring the bell → iPhone push |
| Budget | **Warn only**; shown as **in-world treasury** + **live HUD** |
| Gameplay | **Cozy tool with game flavor** — named crew earns titles |
| Crew | **Named, persistent dwarves** with personalities and quest memory |
| Audio | **Cozy soundscape** (muted by default on phone) |

---

## 2. The cast (model routing)

| Role | Model | Does | Never does |
|---|---|---|---|
| **Forgemaster** | Opus | Talks with you, writes the blueprint (task split + context packs: exact files, line ranges, acceptance checks), reviews & merges smith branches, re-plans on escalation | Write implementation code |
| **Smiths** (2–4) | Sonnet | Execute one scoped blueprint task in their own worktree, run tests | Plan, touch other worktrees, push |
| **Sprites / ravens** | Haiku | Digest long tool output/logs/diffs before they hit Sonnet/Opus; banter, speech bubbles, quest names, the forge chronicle | Edit code |

**Escalation rule:** a smith that fails its acceptance check twice puts down the hammer; the task returns to the Forgemaster's table to be re-planned or split. Nothing silently upgrades to Opus.

**Min-max principles** (where the real savings are):
1. Small, cache-stable prompts: fixed system prompt + fixed tool list per role, so prompt caching hits (cache reads ≈ 10% of input price).
2. Context packs from the blueprint instead of smiths exploring the repo.
3. Haiku digests anything large (test logs, `npm install` output, big diffs) before it reaches a bigger model.
4. Opus reviews *digested* diffs + test results, not raw transcripts.

---

## 3. Architecture

```
iPhone / desktop browser (PWA)
   │  HTTPS + WebSocket over Tailscale Serve
   ▼
WSL2 Ubuntu ─ deepanvil-server (Node/TS)
   ├─ Orchestrator      Agent SDK sessions per role, routing, escalation
   ├─ Permission gate   tiered auto-approve → bell + Web Push
   ├─ Ledger            tokens per model/quest/dwarf, cache hit rate, plan usage est.
   ├─ Event bus         typed events → WebSocket → world animations
   ├─ Store             SQLite: quests, blueprints, crew, ledger, chronicle
   └─ Git               ~/deepanvil/forge/<repo> + worktrees/<dwarf>-<task>
```

- Repos live on the **WSL filesystem** (not `/mnt/c`) for git/node speed.
- Auth: the SDK runs on your Claude Code subscription login inside WSL.

### Event → animation contract (the heart of the "alive" feel)

| Event | In the world |
|---|---|
| `blueprint.proposed` | Scrolls unroll on the drafting table; Forgemaster gestures |
| `blueprint.approved` | Forges flare, smiths walk to anvils |
| `tool.read` / `tool.grep` | Smith consults a tome at the lectern |
| `tool.edit` / `tool.write` | Hammer on the anvil, sparks |
| `tool.bash` | Works the bellows |
| `test.pass` | Quench — steam burst, sword glows |
| `test.fail` | Ingot cracks, smith scratches beard |
| `permission.request` | Smith rings the bell, iPhone push |
| `haiku.digest` | Raven flies a note between stations |
| `usage.tick` | Coins flow from treasury to the anvil; furnace heat = burn rate |
| `escalation` | Smith carries the ingot back to the Forgemaster's table |
| `merge` | Finished piece rides the minecart out of the hall |

This contract is defined first, so the **mock simulator** (beauty phase) and the real orchestrator emit identical events.

### Permission tiers
- **Auto:** read/edit inside own worktree, run tests/linters, local git commit.
- **Bell:** package installs, network access, edits outside worktree, deleting many files.
- **Forgemaster only:** merge to main. **You only:** `git push`, anything touching secrets.

---

## 4. The world

- **Forge-hall:** a mountain cavern with a skylight shaft (god rays, dust motes), glowing crystal veins, a great central furnace, 4 anvil stations, the Forgemaster's drafting table, a lectern/library nook, the quest board, the treasury vault, a bell, a minecart rail out through the mountain.
- **Look:** TSL shaders — toon ramp, painted albedo textures baked in Blender, soft rim light, warm/cool split lighting, bloom on embers/crystals. On desktop, an optional Kuwahara "brushstroke" post-filter.
- **Adaptive quality tiers:** iPhone gets fewer particles, half-res bloom, no Kuwahara, capped DPR; automatic downgrade if the frame time stays high.
- **Controls:** orbit/pinch/tap. Tap a dwarf → their card (current task, tokens, titles). Tap the board/table/treasury → panels.

### Crew (persistent)
4 named smiths + the Forgemaster, each with a look, a quirk, and a memory of completed quests. Titles are earned (e.g. "Breaker of Builds", "Thrice-Quenched"). Haiku uses their personalities for banter.

### HUD (always on)
Plan usage % · 5-hour window countdown · burn rate · today's API-equivalent cost. Warnings only — never stops work.

---

## 5. Asset pipeline (procedural Blender)

1. Install Blender (latest stable) on Windows + the **blender-mcp** add-on/server for Claude.
2. Everything is generated by **Python scripts committed to the repo** (`assets/src/*.py`), so any asset can be regenerated or restyled.
3. Dwarves: procedural chunky stylized mesh on a **compact 12-bone game skeleton** (Rigify was dropped: its control rig is far too heavy for a phone export) with rigid per-part binding → keyframed actions `idle, walk, hammer, read, bellows, ring_bell, cheer, slump, scratch_beard`, exported as named glTF clips. One `crew.glb` serves every dwarf: colour comes from material slots recoloured per dwarf, outfits from variant meshes (hats, beards, apron, tools).
4. Painterly look without textures: AO (BVH raycasts), cool shadow tint, warm top light, brush noise and edge wear painted into vertex colours; toon ramp + warm rim light in the client; Kuwahara brushstroke post-filter on desktop.
5. Export: GLB → gltf-transform meshopt (hall ≈1.8 MB / 125k tris, crew ≈140 KB).
6. Poly Haven (via blender-mcp) only for a sky HDRI/reference if needed.

---

## 6. Build plan (beauty first)

| Milestone | Outcome |
|---|---|
| **M0 Setup** | Repo scaffold (server + client), Blender + blender-mcp, WSL toolchain, Tailscale Serve reaching the phone |
| **M1 The hall** | Procedural greybox → lighting → painterly shaders; runs smoothly on the iPhone |
| **M2 The crew** | Procedural dwarves, Rigify rig, full action set, variations |
| **M3 Living world** | Event contract + mock simulator driving all animations, sprites, ravens, coins, soundscape |
| **M4 The brains** | Orchestrator: Forgemaster chat → blueprint → approval → smiths in worktrees → review/merge, escalation |
| **M5 Treasury & HUD** | Ledger, plan usage estimate, API-equivalent cost, burn-rate furnace |
| **M6 Pocket forge** | PWA install, Web Push for the bell, touch polish, quest board |
| **M7 Lore & polish** | Titles, forge chronicle, banter, more audio, quality tuning |

---

## 7. Risks & open items

- **Subscription + SDK policy:** Anthropic announced (then paused) a separate SDK credit pool for subscriptions (June 2026). ~~Usage % may need estimating~~ — resolved: the engine streams `rate_limit_event`s with real 5-hour / 7-day utilisation, shown live in the HUD.
- **Rate limits:** 4 parallel smiths on a subscription can hit limits — the orchestrator queues/throttles and shows "smith resting" states.
- ~~Procedural + Rigify fragility~~ — resolved: compact scripted skeleton with rigid binding.
- **Painterly on iPhone:** budget the shaders early in M1 on the actual device.
- **iOS PWA:** push only works when the app is installed to the home screen; audio needs a user tap to unlock.
- **PC must be awake** for remote use (power settings / wake-on-LAN later).
- Open items moved to [docs/ROADMAP.md](docs/ROADMAP.md) (2026-10-08): crew lore is proposed in [docs/LORE.md](docs/LORE.md); the quest board ↔ GitHub Issues sync is v2; the music source is decided in v0.6.
