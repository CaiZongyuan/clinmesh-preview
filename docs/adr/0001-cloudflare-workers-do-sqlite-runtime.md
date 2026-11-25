---
status: accepted
---

# Unified Cloudflare Workers and Durable Objects SQLite Runtime

We run the entire backend—Hono HTTP/WebSocket routing, HIS clinical persistence, in-repo durable agent sessions, and Cloudflare `agents/voice` speech pipelines—on a single Cloudflare Workers + Durable Objects runtime using embedded Durable Object SQLite (`ClinicWorkspaceDO` for HIS clinical records, plus per-Encounter `ClinicalCopilotDO`, `SimulatedPatientDO` and `ConsultationVoiceAgent`), instead of splitting a local Node/Bun SQLite server from a separate Cloudflare Worker for voice or introducing D1 for clinical tables. This eliminates cross-runtime glue, guarantees single-transaction atomic clinical commands alongside durable agent checkpoints, and works out of the box locally via `wrangler` / `@cloudflare/vite-plugin`.

## Considered Options

- **Local Node/Bun Hono + local SQLite file + separate Cloudflare Worker for `agents/voice`**: Adds cross-service auth, state sync, and local dev friction between two runtimes.
- **Cloudflare D1 for HIS tables + DO SQLite for agents**: Splits relational clinical state from DO transactional coordination without giving Phase 1 any multi-region scaling benefit.

## Consequences

- All Phase 1 HIS tables live in `ClinicWorkspaceDO` SQLite; if multi-clinic horizontal querying or external SQL reporting is needed later, clinical tables can be projected or migrated to D1 behind the existing repository boundary.
- Local development requires Wrangler / Cloudflare Workers compatibility (no Node-only native addons such as `better-sqlite3`).
