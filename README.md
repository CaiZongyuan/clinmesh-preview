# ClinMesh Preview

Agentic Mini HIS for single-doctor outpatient Encounters. See `GLOSSARY.md` for domain terms and `docs/adr/` for architecture decisions.

## Run it

Requires Node 24+ and pnpm 12.

```sh
pnpm install
pnpm dev         # Vite + Cloudflare Workers runtime: http://localhost:5173
```

`pnpm dev` serves the workbench page and the Worker API from one origin, with `ClinicWorkspaceDO` running locally on embedded SQLite (state under `.wrangler/`). Try `curl http://localhost:5173/api/golden-cases`.

### Model configuration

The Simulated Patient calls an OpenAI-compatible `/chat/completions` endpoint (default model `glm-5.3-flash`, `low` reasoning effort). Non-secret defaults are `vars` in `wrangler.jsonc`; the key is a secret. Put it in `.dev.vars` (gitignored, never committed):

```sh
# .dev.vars
LLM_API_KEY=<your key>
# Optional overrides of the wrangler.jsonc defaults:
# LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
# LLM_MODEL=glm-5.3-flash
# LLM_REASONING_EFFORT=off|low|medium|high
# LLM_EFFORT_STYLE=zhipu|openai|none      # how effort is sent: thinking.type, reasoning_effort, or not at all
# PATIENT_LLM_MODEL=...                   # any LLM_* key prefixed PATIENT_ (or COPILOT_) applies to that agent only
# PATIENT_TURN_TIMEOUT_MS=30000           # a reply past this fails and releases the lock
# PATIENT_TURN_EXPIRY_GRACE_MS=5000       # extra wait before the workspace itself fails an unsettled reply
```

Without `LLM_API_KEY` the workbench still runs: each patient reply fails at once with `llm-not-configured`, visibly, with a retry button. The GLM endpoint facts (base URL, reasoning field, effort mapping) are not yet verified against a live key.

### HTTP API

Request and response shapes live in `src/shared/`. Errors answer `{ "error": { "code", "message" } }`.

| Route | What it does |
| ----- | ------------ |
| `GET /api/golden-cases` | The queue; `queueStatus` is `in-encounter` while a Golden Case has the active Encounter |
| `POST /api/encounters` `{ caseId }` | Starts an Encounter (201); `409 active-encounter-exists` while another is active |
| `GET /api/encounters/active` | The workspace's active Encounter, or `null` |
| `GET /api/encounters/:encounterId` | One Encounter: patient banner, pre-examination triage vitals and Visible Source History only |
| `POST /api/encounters/:encounterId/abandonment` | Encounter Abandonment; `409 encounter-not-active` once it is frozen |
| `GET /api/encounters/:encounterId/audit-events` | Audit trail with `practitionerId` |
| `GET /api/encounters/:encounterId/consultation` | The Consultation transcript: doctor and patient turns in order (speaker, source, attribution, status, failure) |
| `POST /api/encounters/:encounterId/consultation/doctor-turns` `{ clientTurnId, text }` | Records a typed question and a pending patient turn, and asks the Simulated Patient (201); idempotent per `clientTurnId`; `409 patient-turn-pending` while the previous reply is pending |
| `POST /api/encounters/:encounterId/consultation/patient-turns/:turnId/retry` | A new reply attempt to the latest, failed patient turn (201); the failed one stays; `409 patient-turn-not-retryable` otherwise |
| `GET /api/encounters/:encounterId/patient/socket` | WebSocket: the Simulated Patient's reply stream (`src/shared/agent-wire.ts`). Send `{ "type": "hello", "afterSeq": n }`; the server replays events after `n`, sends `replay.done`, then live events. `426` without an upgrade |

Two Worker-seam tests enumerate the Hono app's routes and fail until a new route is listed:

- `test/worker/truth-isolation.test.ts` probes every route for Case Truth with the shared denylist in `test/worker/case-truth.ts` (`expectNoCaseTruth`), which later tickets reuse for WebSocket frames, Simulated Patient replies and Copilot context.
- `test/worker/write-freeze.test.ts` sends every write command under `/api/encounters/:encounterId` to an abandoned Encounter and expects `409 encounter-not-active`.

WebSocket routes must be registered on the same Hono app (not dispatched beside it in `src/worker/index.ts`), so the enumeration sees them.

| Script           | What it does                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm dev`       | Local dev server (pass `--port <n>` to change the port)                                          |
| `pnpm build`     | Builds the client assets and the Worker into `dist/`                                             |
| `pnpm typecheck` | `tsc -b` over the web, Worker and tooling projects                                               |
| `pnpm test`      | Both test seams: `worker` (Workers Vitest pool, real Hono + Durable Object + SQLite) and `web` (jsdom + Testing Library, real router + workbench, fetch stubbed) |
| `pnpm cf-typegen`| Regenerates `src/worker/worker-configuration.d.ts` after changing `wrangler.jsonc`               |

Run one seam with `pnpm test --project worker` or `pnpm test --project web`.

## Layout

- `src/worker/` Hono app (`app.ts`), Worker entry (`index.ts`), `ClinicWorkspaceDO`, and repositories over its SQLite store.
  - `durable-agent/` The in-repo durable agent runtime (our `pi-durable`): runs queued by commands and executed by the Durable Object alarm, LLM steps checkpointed in the agent's SQLite, crash recovery on the next alarm, per-run deadlines, an event log replayed to hibernatable WebSockets, and an outbox that delivers a run's outcome to the workspace at least once. Domain-agnostic; agents plug in through `AgentDefinition`.
  - `llm/` Provider-neutral LLM types, the OpenAI-compatible streaming adapter, per-agent configuration, and the scripted-provider hook the Worker-seam tests install (`LLM_PROVIDER=scripted`).
  - `simulated-patient/` `SimulatedPatientDO` (one per Encounter) and its context: Patient Persona, doctor utterances and its own settled replies, nothing else. It never imports the Golden Case pack.
- `src/web/` React app: TanStack Router routes (`router.tsx`), workbench components, styles and tokens.
- `src/shared/` Types shared by the API and the browser.
- `data/` Pinned data snapshots. `data/provenance.json` records each snapshot's source paths and reference commit.
- `test/worker/`, `test/web/` The two test seams; `test/fixtures/` holds what both seams expect of Golden Case 1.
- `prototypes/copilot-workbench/` Reference prototype, not production code.
