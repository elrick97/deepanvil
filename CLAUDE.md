# Deepanvil

A painterly 3D dwarven forge-hall that visualizes and drives AI coding agents. Full design: [DESIGN.md](DESIGN.md).

## Layout
- `apps/client` — Vite + vanilla three.js (`three/webgpu`, TSL). Runs on **Windows** Node.
- `apps/server` — forge server (`node:http` + `ws`). Runs in **WSL2 Ubuntu** on Node 24, executing `.ts` directly via type stripping — keep server code erasable-syntax only (no enums, namespaces, or parameter properties) and its deps pure JS, since `node_modules` is shared with Windows.
- `packages/shared` — the event contract (`events.ts`) both sides speak. The mock simulator and the real orchestrator must emit identical events.
- `tools/blender` — launcher scripts for blender-mcp (the add-on itself is installed with `uvx mcp-for-blender==2.1.9 install-addon`, never vendored).
- `assets/src` — procedural Blender Python that builds the hall. Layout lives in `forge/layout.py` (authored in three.js coords via `P()`); the client places lights, crew and effects from exported `anchor_*` empties, so move things there, not in client code. Parts the client animates (bell, bellows, minecart, ingots) are built with `keep=True` and stay separate nodes; parts sharing a `join=` key merge into one node per material after painting (the vault door, scales beam/pans).

## Commands
- `npm run server` — the **live** forge in WSL on :8787 (idles until you ask Thráin for a quest in the UI). Env: `DEEPANVIL_REPO` (default `~/deepanvil/forge/sandbox`), `DEEPANVIL_SMITHS` (default 2). `MOCK=1` runs the quest simulator instead (`apps/server/src/mock.ts`): blueprint → approval → tasks with reads/edits/tests/retries/escalation/bell → merge. New clients get the current quest's state events replayed after `hello`.
- `npm run dev` — client on http://127.0.0.1:5173 (proxies `/ws` and `/health` to the server).
- `npm run typecheck` — TypeScript 7 across all packages.
- `npm run assets:crew` / `assets:odin` / `assets:coin` — the dwarf kit, rigged Odin (+ raven), the coin.
- `npm run assets` — headless Blender builds + paints (raycast AO into vertex colours) + exports `apps/client/public/assets/hall.glb`, then meshopt-compresses it (~5 s). Pass extra args after `--`, e.g. `-- --rays 48 --save` (also writes `assets/out/hall.blend`).
- `npm run assets:coin` — the gold coin (`build_coin.py`): `coin.glb` for flying coins + a rendered `coin.png` HUD icon.
- `scripts\blender.cmd` — opens Blender with the MCP socket on localhost:9876 (the `blender` MCP server in `.mcp.json` talks to it).
- Add `?q=low|medium|high` to the client URL to force a quality tier.

## Live agents (apps/server/src/agents)
- `run.ts` is the only door to the Agent SDK: pins the engine, isolates settings + MCP, emits coins/limits/ledger. Always go through it.
- Engine: the SDK's native binary must match the SDK version and be Linux — it lives in `~/.deepanvil/engine` in WSL (`npm i @anthropic-ai/claude-agent-sdk-linux-x64@<sdk version>` there when bumping the SDK). It uses the WSL `~/.claude` subscription login.
- Planning is a short conversation (`forgemaster.ts` `plan()` → `PlanTurn`): Opus returns clarifying questions (≤2 rounds; the form is `client/src/clarify.ts`) or a blueprint; answers, his repo notes and the original request are re-sent each turn (no persisted session). The orchestrator's `Draft` holds the state; stopping while he waits shelves the quest. A proposed blueprint (`PendingQuest`) can be revised (`blueprint.revise` → Opus turn with the old plan + your note, announced as `blueprint.revising`, delivered as `blueprint.revised`: a revision is not a new quest, so never re-emit `blueprint.proposed`) or have tasks dropped (`blueprint.drop`, no tokens). While forging, `Forge.run` (`QuestRun`) is the live task list: a smith's `blocked` outcome goes to `replanBlocked()` → `triage()` (rewrite / reslice / ask) → `applyAmendment()`; growing the scope waits on `plan.change`. Replaced tasks are neither merged nor failed. `quest.rescope` (the composer while forging) → `rescope()` → a proposal that always waits on `plan.change`; every task has its own `AbortController` (`QuestRun.cancel`, passed to the smith as `SmithRun.abort`) so one smith can be stopped alone.
- Tiers: Opus plans/re-plans (`forgemaster.ts`), Sonnet smiths code in worktrees (`smith.ts`), Haiku digests/banter (`sprite.ts`). Permissions: `permissions.ts` allowlist (keep its table test passing).
- **Odin keeps `main`** (`odin.ts`, `gates.ts`, `odin-review.ts`, design in `docs/ODIN.md`): smiths never merge; finished work is *offered*, rebased onto main in Odin's scratch worktree (`<repo>.anvils/odin`), gated (tests/types/lint, no tokens), reviewed by Sonnet (always Sonnet), then main is fast-forwarded. Policy per repo lives in the DB (`repo_policy`), auto-detected; sandbox = `auto`, other repos = `approve` (offering cards).
- Quest history: `history` (last 30 quests) is a gauge event; `history.open` → `quest.detail` (`store.questDetail`) loads one quest on demand for the 📜 panel (`client/src/history.ts`).
- Vault panel: `vault.open` → `vault.info` (`Odin.policy` + `store.recentOfferings`: current revision's gates with output tails, review); client `vaultpanel.ts`, opened by tapping the door (`Vault.doorTarget`) or the HUD "main" chip.
- Repo instructions (`instructions.ts`): CLAUDE.md / .claude/CLAUDE.md / AGENTS.md are read from HEAD as data (symlinks skipped, in-repo `@imports` one level, size-capped) and appended to the planner's and smiths' system prompts (`systemFor`, `smithSystem`) and given to Odin's review as conventions (from the base branch). Never turn on the engine's `settingSources: ['project']`: it would also load the repo's hooks, MCP servers and permission rules, and a freshly cloned repo must not run commands.
- Trust: gates execute a repo's own scripts, so `Forge.trusted(repo)` (the sandbox, or a repo with a quest ever approved: `store.hasForged`) decides whether switching to it or restarting on it runs Odin's health check. A just-added or cloned project runs nothing until the first approved quest (`forge()` does the check then).
- Projects: `Forge.cfg.repo` is mutable. `project.add/clone/switch/forget` (orchestrator.ts) → `projects` gauge event; the active one is stored (`settings.activeProject`) and `DEEPANVIL_REPO` overrides it at startup. `inspectRepo` (git.ts) decides what is a valid project; `Forge.base` is the branch Odin keeps (the repo's checked-out branch). History and pending blueprints are per repo. Switching is refused unless `idle()`.
- `bash scripts/server.sh selftest` (in WSL): zero-token orchestration test with stub agents on a throwaway repo — run it after touching the orchestrator, permissions or store. `smoke` measures per-call overhead on Haiku. Sandbox repo: `bash scripts/setup-sandbox.sh` (in WSL).

## Always-on forge (production)
- The forge server also serves the production client (`apps/client/dist`): one process, one origin, gzip for text.
- Runs at Windows logon via `Startup/Deepanvil Forge.vbs` → `scripts/forge-service.sh` (restart loop; its wsl.exe keeps the WSL VM alive).
  `npm run forge:install` / `forge:start` / `forge:restart` (after server changes) / `forge:log`. Client changes need `npm run build`.
- State: SQLite at `~/.deepanvil/forge.db` (`apps/server/src/store.ts`); VAPID keys at `~/.deepanvil/vapid.json`.
- Don't start a second server on :8787 from a session; the `client` launch config (Vite :5173) proxies to the always-on one.

## Phone access
Tailscale Serve proxies `https://<your-pc>.<your-tailnet>.ts.net` → `http://localhost:8787` (tailnet-only). WSL forwards :8787 to Windows on IPv6 only — Tailscale must target `localhost`, not `127.0.0.1` (and it mangles `[::1]`).
PWA: manifest + `public/sw.js` (push, Allow/Deny actions → `POST /api/answer`). iPhone push only works after "Add to Home Screen".

## Gotchas
- Money is shown in gold: 1 coin = 1¢ API-equivalent (`client/src/coins.ts`); never show `$` in the world UI (dollar values go in hover titles only).
- `InstancedMesh` draws every slot even at zero scale — keep `mesh.count` = last live index + 1 (see `world/fx.ts`).
- Agent calls MUST keep `strictMcpConfig: true, mcpServers: {}` (default in `run.ts`): otherwise the account's claude.ai connectors (Gmail, Calendar…) load into every agent — a privacy leak and ~37k tokens per call.
- Each distinct agent config (tools, outputFormat) is its own prompt-cache prefix: keep configs stable per role so calls hit cache.
- WSL2 sometimes forwards :8787 to Windows on `[::1]` only — reach the server via `localhost`, not `127.0.0.1`. To kill a stray server use `wsl -- ps`/`kill <pid>` (a `pkill -f` pattern inside `bash -c` matches and kills its own shell).
- The client only learns behaviour from events: crew intents (walk to lectern/bell/table, hammer at home) live in `world/crew.ts`, routes in `world/nav.ts` (ring walkway around the furnace).
- Event text will come from real agents: render it with `textContent`, never `innerHTML`.
- `optimize-glb.mjs` must not dedup materials: they are identical white placeholders whose *names* carry meaning.
- Crew facing: Blender -Y is the dwarf's front (three +Z). Anchors' yaw uses `yaw_to()` with the same convention.
- Headless Cycles vertex-colour baking returned garbage in Blender 5.2 — AO is computed with BVH raycasts in `forge/paint.py` instead.
- three r183+: use `THREE.RenderPipeline` (not `PostProcessing`). `MeshToonMaterial` has no `flatShading` — use `facet()` from `world/toon.ts`.
- Don't set `rotation.x/z` on objects oriented with `lookAt` (Euler can be ±π) — animate an inner group instead.
- meshopt quantization stores a scale/offset on each node: animate kept parts relative to their rest transform.
- In dev, `window.scene/camera/crew/fx/hall/vault/THREE` and `forgeDispatch(event)` are exposed for debugging.
