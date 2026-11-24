# ClinMesh Preview

Agentic Mini HIS for single-doctor outpatient clinical encounters, combining a `Simulated Patient` and an ambient `Clinical Copilot` over Cloudflare Workers, Hono, Durable Object SQLite, `pi-durable`, `@ui-sdk/react`, and Alibaba Cloud Bailian voice (`paraformer-realtime-v2` + `sambert`).

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
- **Default Agent LLM**: Default local `pi` / `pi-durable` model is `glm-5.3-flash` (`low` reasoning effort), overridable via environment variables per agent (`Clinical Copilot` vs `Simulated Patient`).
