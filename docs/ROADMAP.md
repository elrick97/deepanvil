# Deepanvil — Road to 1.0

Planned 2026-10-08 from a gap analysis of v0.1 + O3 and an interview. Design: [DESIGN.md](../DESIGN.md),
Odin: [ODIN.md](ODIN.md), crew lore proposal: [LORE.md](LORE.md).

## 1. What "launch" means

**Deepanvil 1.0 is a public release others can install and trust on their own repos**:

- **Install:** one command (`npx deepanvil`), with a first-run wizard.
- **Platforms:** Windows + WSL, macOS and Linux.
- **Providers:** Claude, OpenAI and Gemini agents through their own CLIs and subscriptions.
- **Agent features:** a full conversation with the planner, live insight into every agent, and GitHub PR mode.
- **The world:** it lives on its own, even when nothing is being built.

Out of scope for 1.0, and kept for v2:

- several forges at once (the "factory");
- mixed-provider ensembles (for example, Gemini reviewing Claude's work);
- syncing the quest board with GitHub Issues;
- attaching images to requests.

## 2. Decisions locked in this round

| Area | Decision |
|---|---|
| Audience | Public 1.0 for others; stable releases, docs, demo video |
| Agent chat | **Full conversation**. Thráin asks clarifying questions, revises the blueprint from your feedback and answers questions about the repo. You can whisper to a smith mid-task. |
| Projects | **Picker, one active forge at a time.** Each repo keeps its own history, policy and chronicle. Several forges at once is the v2 "factory". |
| GitHub | **PR mode (O4)**: Odin pushes, opens a PR, waits for CI, merges with `gh`. Local mode stays the default. |
| Providers | **Per-role adapters over each vendor's agent runtime**, each on the user's own login: Claude Agent SDK, OpenAI Codex SDK and Gemini CLI. Any role can be assigned any provider and model in settings. |
| Providers in the world | **Guest crafters from other realms.** Claude's crew stay dwarves; other providers arrive as visiting guilds with their own look (see LORE.md). |
| Devices | Desktop and phone equally: desktop for planning and diffs, phone for watching, approving and the bell |
| Crew | I propose the lore and you edit it. Users can rename and restyle their crew. |
| World life (1.0) | Idle life and day/night, a hall that grows with your work, chronicle with titles and achievements, camera and music: **all four** |
| Platforms | Windows + WSL, macOS and Linux, all native, with the doctor covering each |
| Packaging | `npx deepanvil` plus a setup wizard in the browser |
| Claude Code parity | Project instructions and skills, live transcript and command view, opt-in MCP per repo |

### Design calls still to confirm (recommendations)

1. **Questions about the repo go to the Library, not to Opus.** A read-only Sonnet "scholar" answers at the lectern, so Opus stays the planner and chat stays cheap. Thráin hands over when a question isn't a quest.
2. **Thráin plans as a short conversation per quest, carried by a notes digest.** Each turn he returns questions or a blueprint, plus a few hundred words of notes about the repo that travel with the answers, so a later round does not re-read it. (Chosen over resuming a persisted agent session: that would write planner sessions into the user's own `~/.claude` history and would not survive a forge restart.) Blueprint revisions and replans (v0.3, next slices) are further turns of the same conversation.
3. **The event contract becomes provider-agnostic.** `model` changes from `'opus'|'sonnet'|'haiku'` to `{ provider, model, tier }`. Coins stay "API-equivalent cents", priced per provider. Each provider gets its own window gauges.
4. **Remote access needs pairing for the public release.** Today the forge trusts anyone who can reach it. 1.0 pairs each device once (a QR code or 6-digit code shown on the host) and stores a per-device token. Tailscale stays recommended, not required.
5. **Settings live in SQLite and are edited in an in-world "ledger room" panel.** They cover providers per role, smith count, Odin's policy (auto or approve, protected paths, gates) and MCP allowlists. Environment variables become overrides only.

## 3. Gap analysis

Legend: ✓ done · ◐ partial · ✗ missing. "Ver." is the target release (§4).

### A. Talking to the agents

| Capability | Today | Gap | Ver. |
|---|---|---|---|
| Ask for a quest | ✓ chat box → Opus blueprint | — | — |
| Clarifying questions before planning | ✗ | The planner should be able to ask, with answers in the same thread | 0.3 |
| Revise a blueprint with feedback | ✗ rejecting discards the plan; "tell me what to change" starts from scratch | Revise in-thread, keeping context | 0.3 |
| See the blueprint in detail | ◐ only task titles reach the UI | Context packs, files, acceptance checks; edit or reorder or drop tasks before approval | 0.3 |
| Ask about the repo without a quest | ✗ | Library "scholar" (read-only) | 0.3 |
| Talk to a smith mid-task | ✗ | Whisper: a note injected at the smith's next turn | 0.3 |
| Control a single task | ✗ only stop-all | Pause, cancel or retry one task; reassign it to another smith | 0.3 |
| Answer the bell | ✓ desktop, push with Allow/Deny | "Always allow this" rules per repo (shown and revocable) | 0.4 |
| Review before merge | ✓ offering cards plus diff (approve mode) | Inline comments in the diff become the send-back note; whole-quest diff at the end | 0.4 |
| Quest outcome | ◐ ticker plus minecart | Quest report: what changed, files, tests, coins, time; link to the PR | 0.4 |
| Project instructions | ✗ `settingSources: []` ignores CLAUDE.md | Load CLAUDE.md / AGENTS.md / GEMINI.md and repo skills per provider; per-repo custom gates | 0.3 |
| MCP for agents | ✗ deliberately off | Opt-in per repo, explicit tool allowlist, shown in the world (see E) | 0.4 |
| Quest backlog | ✗ one quest at a time, no queue | The quest board: queue requests, reorder, start next automatically | 0.4 |

### B. Seeing what agents do

| Capability | Today | Gap | Ver. |
|---|---|---|---|
| Activity at a glance | ✓ animations and ticker | — | — |
| Tap a dwarf | ✗ | Card: task, current command, last output, coins, attempts, titles; buttons for whisper, cancel, follow | 0.2 |
| Running command | ◐ ticker text only | Slate above the anvil with the live command; per-command animations (install = sack of ore, git = runes, network = raven) | 0.2 |
| Full transcript | ✗ | Live transcript and terminal view per dwarf (tool calls, output tails, thinking summaries), searchable | 0.2 |
| To-do progress | ✗ | Chalkboard per anvil from the smith's to-do list | 0.2 |
| Quest history | ◐ the server sends `history`, the client ignores it | History panel: past quests, outcomes, cost; re-open a report | 0.2 |
| Odin's queue | ◐ in-world plus cards | Vault panel (tap the door): queue, gate logs, health of main | 0.2 |
| Errors | ◐ red ticker line | Error card with cause and fix; doctor link | 0.4 |

### C. Budget and limits

| Capability | Today | Gap | Ver. |
|---|---|---|---|
| Coins, 5h/7d gauges, treasury, furnace heat | ✓ Claude only | Per-provider gauges and pricing | 0.5 |
| Rate limit hit | ✗ no visible state | "Resting" dwarves (sit by the fire), auto-resume when the window resets, push when resumed | 0.2 |
| Budget planning | ✗ | The blueprint shows an estimated coin cost; optional soft caps per quest | 0.4 |

### D. Projects and integration

| Capability | Today | Gap | Ver. |
|---|---|---|---|
| Choose a repo | ✗ env var | Project picker: add a local path or clone from GitHub, switch forges; per-repo history and policy | 0.4 |
| Dirty repo | ◐ refuses with a message | Offer to stash / commit / continue on a branch | 0.4 |
| PR mode | ✗ | O4: push, PR, CI watch, merge via `gh`; PR link in the report | 0.4 |
| Settings UI | ✗ env + DB | Ledger-room settings panel (see §2.5) | 0.4 |

### E. Providers

| Capability | Today | Gap | Ver. |
|---|---|---|---|
| Runtime abstraction | ✗ Claude SDK wired into the agents | `Runtime` adapter interface: plan, smith, review, digest, banter; capability flags (sandbox, structured output, hooks, rate-limit events) | 0.5 |
| OpenAI | ✗ | Codex SDK adapter (ChatGPT login), sandbox mapping, cost and limits | 0.5 |
| Gemini | ✗ | Gemini CLI adapter (Google login), headless JSON mode | 0.5 |
| Per-role assignment | ✗ | Settings: provider + model per role; the doctor checks each login | 0.5 |
| Permissions and sandbox parity | ◐ Claude-specific allowlist | One policy layer mapped onto each runtime's approval hooks; self-test per adapter | 0.5 |
| Guest guilds in the world | ✗ | Gnome and elf crafters (assets, rigs, clips) | 0.6 |

### F. World and life

| Capability | Today | Gap | Ver. |
|---|---|---|---|
| Hall, crew, Odin, vault, ravens, coins, sound | ✓ | — | — |
| Crew identity | ◐ placeholder names and looks | Lore (LORE.md), voices in banter, rename and restyle | 0.6 |
| Idle life | ◐ idle and pondering clips only | Off-duty routines: eat, nap, dice, sweep, tend the garden, visit the bench | 0.6 |
| Day/night and weather | ✗ fixed noon | Sky hole follows local time; dusk lamps; rain or snow through the opening | 0.6 |
| Hall grows | ✗ | Trophies per merged quest, a banner per project, decor milestones | 0.6 |
| Chronicle and titles | ✗ | Muninn keeps the chronicle (Haiku saga per quest); titles and achievements | 0.6 |
| Camera | ◐ orbit plus auto-rotate | Tap to follow, focus on events, merge and escalation cinematics, photo mode | 0.6 |
| Music | ✗ ambience only | Cozy adaptive score (calm / forging / triumph), CC0 or commissioned | 0.6 |

### G. Launch readiness

| Capability | Today | Gap | Ver. |
|---|---|---|---|
| Install | ◐ manual steps on WSL | `npx deepanvil`; browser setup wizard (providers, repo, sandbox, service) | 0.7 |
| macOS / Linux | ✗ scripts assume WSL | Native service install (launchd, systemd user unit), sandbox per OS (bubblewrap / Seatbelt) | 0.7 |
| Remote auth | ✗ trusts the network | Device pairing and tokens (§2.4) | 0.7 |
| Accessibility | ✗ | Reduced motion, text size, colour-blind-safe rune and gate colours (shapes, not just hues), screen-reader labels on panels | 0.7 |
| Battery and performance | ◐ adaptive tiers | Pause rendering when hidden; low-power "diorama" mode on the phone | 0.2 |
| Tests | ◐ zero-token self-test and typecheck | Client end-to-end (mock forge → screenshots), adapter self-tests, release CI matrix (three OSes) | 0.7–1.0 |
| Docs | ◐ README and design docs | Docs site: quick start per OS and provider, security model, FAQ, troubleshooting | 0.7 |
| Release | ✗ | semver, changelog, npm publish, signed tags, demo video, landing page with the mock world | 1.0 |

## 4. Releases

Each release is usable on its own; every one keeps the mock simulator and self-test in step with the
event contract.

### v0.2 — "Clear sight" (done 2026-10-09)
- ✓ O3: Odin and the Vault of Main in the hall.
- ✓ Tap-a-dwarf card (task, current action, coins, follow camera) with a live transcript per dwarf: the agent's words, commands and output tails (`dwarf.log` events, replayed to late joiners).
- ✓ Command slate in front of each anvil (what the smith runs now; green or red on test results).
- ✓ To-do chalkboard under each slate (the smith's own to-do list, `dwarf.todos` events, replayed to late joiners).
- Per-command animations moved to v0.6 (polish: they mostly reuse existing clips).
- ✓ History panel (📜 in the HUD): every past quest with outcome and coins; tap one for the request, each task with its smith and summary, spend per tier, and Odin's verdict on each piece.
- ✓ Vault panel (tap the door, or the "main" chip): is main green, Odin's rules (merge mode, gates and their commands, size limit, protected paths) and the latest offerings with each gate's output and his review; refreshes while open.
- ✓ Rate-limit "resting" state (a rejected call rests until the window resets, then the same call runs again; crew naps, HUD countdown, push on rest and wake); push for every needs-you moment (blueprint ready, awaiting you, main red, quest done).
- ✓ Calm mode: after 25 s with no events or input the hall renders at 30 fps (a hidden tab already pauses); anything wakes it.

### v0.3 — "Talk to the forge" (conversation done 2026-10-09; the rest follows later)
- ✓ Clarifying questions: Thráin asks (at most two rounds, a recommended pick on every question) in a small form before he drafts; "Just draft it" uses his picks.
- ✓ Blueprint card: task detail (brief, files, acceptance), drop a task for free, ask Thráin for changes (he redraws in the same conversation; at most 6 redraws per blueprint). Inline editing of a task's text is still open.
- ✓ Replanning ladder: a smith flags `blocked` (wrong assumption / too big / depends on another task / out of scope) instead of failing; Thráin triages: rewrite (automatic), re-slice (automatic unless it adds more tasks than it replaces, then a card with the diff waits for your yes), or ask you through the question form. At most 3 replans per quest; merged work stays on main.
- ✓ Rescope mid-quest by hand: while forging, the composer becomes a "change the plan" line; Thráin sees every task and where it stands and proposes a re-cut (drop queued or running tasks, add up to 4) that always waits for your yes. Merged work and pieces with Odin are never touched; at most 4 per quest.
- Still to do: library scholar for repo Q&A (read-only Sonnet at the lectern); whisper to a smith; pause, cancel or retry a single task; editing a task's text in the blueprint card.

### v0.4 — "Real repos"
- Project picker (local path or GitHub clone), dirty-repo handling, settings panel.
- Project instructions and skills (CLAUDE.md / AGENTS.md) for Thráin and the smiths; per-repo custom gates. (Today `settingSources: []` makes agents ignore a repo's own instructions: the first thing real repos need.)
- O4 PR mode; quest report; whole-quest diff with inline comments as send-back notes.
- Quest board backlog; "always allow" permission rules; opt-in MCP per repo.
- Cost estimate on blueprints; error cards.

### v0.5 — "Other realms"
- `Runtime` adapter layer; the Claude adapter is extracted first with no behaviour change (self-test proves it).
- Codex and Gemini adapters, per-role assignment, doctor checks, per-provider coins and limits.
- Provider-agnostic event contract (`{ provider, model, tier }`).

### v0.6 — "The living hall"
- Crew lore and voices; guest guilds (gnomes, elves) as rigged characters.
- Idle routines, day/night, weather; trophies and banners; chronicle, titles, achievements.
- Camera follow, cinematics, photo mode; music score.

### v0.7 — "Anyone can forge"
- `npx deepanvil` and setup wizard; native macOS and Linux; device pairing.
- Accessibility pass; docs site; release CI matrix and client end-to-end tests.

### v1.0 — Launch
- Real-repo mileage (at least three outside projects across languages), a fresh security audit, performance on a mid-range phone.
- Release process, demo video, landing page with the live mock world.

### v2 — Stretch
- **The factory:** several forges at once, one hall per project, joined by mine tunnels.
- **Ensembles:** mixed providers on one quest (for example, a Gemini elf reviews a Claude smith's work at Odin's side).
- Quest board ↔ GitHub Issues; images and files in requests; voice.

## 5. Risks

- **Provider runtimes differ:** sandboxing, approval hooks, structured output and rate-limit signals are not uniform. Mitigation: capability flags per adapter, a shared policy layer, and self-tests per adapter. Ship Claude-first if an adapter lags.
- **Subscription terms:** driving vendor CLIs from a harness must stay within each provider's terms. Check them before 0.5 ships.
- **Scope:** the world features (0.6) are large. Each is independently shippable and behind the event contract, so they can slip without blocking launch.
- **Cost of conversation:** chat must not quietly burn Opus. Route Q&A to the scholar, summarise threads, and show the coin cost of each reply.
