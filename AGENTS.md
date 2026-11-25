# ClinMesh Preview

Agentic Mini HIS for single-doctor outpatient clinical encounters, combining a `Simulated Patient` and an ambient `Clinical Copilot` over Cloudflare Workers, Hono, Durable Object SQLite, an in-repo durable agent runtime (`src/worker/durable-agent/`, ADR-0002), `@ui-sdk/react`, and Alibaba Cloud Bailian voice (`paraformer-realtime-v2` + `sambert`).

## Agent skills

### Issue tracker

Issues, specs, and tracer-bullet tickets live in GitHub Issues on `CaiZongyuan/clinmesh-preview` via `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five canonical triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo (`GLOSSARY.md` and `docs/adr/` at the repo root). See `docs/agents/domain.md`.

## Development conventions

- **UI (`@ui-sdk/react`)**: Before building or modifying UI components, follow the `ui-sdk` skill and read `node_modules/@ui-sdk/react/docs/llms.txt`.
- **Voice (`voice` skill)**: Real-time STT uses Alibaba Cloud Bailian `paraformer-realtime-v2` and TTS uses `sambert` via `BAILIAN_TOKEN` (from `D:\Environment\.env` or `.dev.vars`). See `.agents/skills/voice/SKILL.md`.
- **Default Agent LLM**: `glm-5.3-flash` at `low` reasoning effort; `PATIENT_LLM_*` / `COPILOT_LLM_*` override `LLM_*` per agent (keys in `.dev.vars`).

## Lessons

Each lesson is a rule this repo learned from a recurring problem. Apply them when writing and reviewing code.

- **Effects**: derive values during render and act in event handlers; reserve `useEffect` for syncing with an external system (socket, timer, media device).
- **Comments**: let names, types and tests carry the intent; comment only a constraint the code cannot show (a platform quirk, a spec quote).
- **Tests**: prove each invariant test by removing its guard once and watching it go red; a test that stays green is hollow.
- **Case Truth**: read it only through `caseTruth(caseId, caseVersion)`, and Report content only through `releasedReports(encounter, now)`; keep ids and doctor-visible data diagnosis-neutral. Scope test exemptions for runtime metrics to numeric fields on the matching message type.
- **Schema**: append one migration to `src/worker/workspace-schema.ts`; when a rebase collides, renumber yours and reset local `.wrangler/state`.
- **Worktrees**: push a WIP commit as soon as the branch exists; keep temp files and PR bodies in the worktree's `.scratch/issue-<N>/`.

### Curating (PM)

- Add a lesson when a problem recurs (or on the first Case Truth leak): one line, stated as the rule to follow, led by a bold keyword. Durable rules live here or in `docs/`; scratch files and chat vanish between sessions.
- Keep the list short: merge overlapping lessons, delete stale ones, and when a lesson becomes a test or lint check, delete the lesson.
- After each merge, delete the merged branch (local and remote) and its worktree, run `git worktree prune`, and update or delete docs the change made stale.
