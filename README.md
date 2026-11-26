# ClinMesh Preview

Agentic Mini HIS for single-doctor outpatient Encounters. See `GLOSSARY.md` for domain terms and `docs/adr/` for architecture decisions.

After confirming a Diagnosis, the 处方 tab searches the formulary by name, pinyin or class — every hit is tagged 与过敏史冲突 or 交叉过敏风险 before it can be added — and issues with Clinical Confirmation. Allergy rules match by drug class: a penicillin-class drug for a penicillin-allergic patient is refused whole server-side (`MEDICATION_ALLERGY_CONFLICT`, 药事安全红线拦截， no override); a cephalosporin needs a reason from a fixed list plus a ≥4-character note, stored on the issued line and in the audit log. Self-limiting visits record 无需用药 instead, mutually exclusive with issued prescriptions both ways.

## Run it

Requires Node 24+ and pnpm 12.

```sh
pnpm install
pnpm dev         # Vite + Cloudflare Workers runtime: http://localhost:5173
```

`pnpm dev` serves the workbench page and the Worker API from one origin, with `ClinicWorkspaceDO` running locally on embedded SQLite (state under `.wrangler/`). Try `curl http://localhost:5173/api/golden-cases`.

### Model configuration

The Simulated Patient and Clinical Copilot call an OpenAI-compatible `/chat/completions` endpoint (default model `glm-5.3-flash`, `low` reasoning effort). Non-secret defaults are `vars` in `wrangler.jsonc`; the key is a secret. Put it in `.dev.vars` (gitignored, never committed):

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

On `pnpm dev`, the local Worker sends model streams and Bailian voice connections through the host's `HTTP_PROXY` / `HTTPS_PROXY` when configured. The development server starts and stops its own loopback relay and honors `NO_PROXY`. Each agent uses its configured API base URL and bearer token.

Without `LLM_API_KEY` the workbench still runs: each patient reply fails at once with `llm-not-configured`, visibly, with a retry button. Use the API base URL that matches your credential. Z.ai Coding Plan credentials use `https://open.bigmodel.cn/api/coding/paas/v4`. The Clinical Copilot shows a failed turn when the model is unconfigured.

### Voice configuration

The doctor can speak instead of type (持续收音 hands-free with recognizer VAD, or 按住说话 push-to-talk). With a Bailian token the Worker streams the microphone to `paraformer-realtime-v2` over the DashScope duplex WebSocket (ADR-0003); without one, the browser's own Web Speech API recognizes speech and the text goes over HTTP. `GET /api/voice` reports which:

```
# .dev.vars
BAILIAN_TOKEN=...   # secret; enables Paraformer recognition and Sambert playback
BAILIAN_WORKSPACE_ID=...  # optional Beijing workspace ID for its dedicated MaaS host
```

A Paraformer-recognized turn carries `voice: { recognizer, durationMs, confidence: null }` (Paraformer reports no confidence score). The voice socket `/api/encounters/:encounterId/voice` speaks the Cloudflare `agents/voice` protocol plus ClinMesh messages (`src/shared/voice.ts`); it is refused once the Encounter is frozen.

The workbench can play the Simulated Patient's reply through Sambert as its text arrives. The Consultation shows playback progress, mute and per-reply replay. Speaking into either capture mode interrupts current playback. Automatic playback is subject to the browser's media policy.

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
| `GET /api/investigation-catalog` | The investigation catalog for search (no results, only display fields) |
| `GET /api/medication-catalog` | The formulary: name, class, pinyin, package, defaults and package-insert summary |
| `GET /api/encounters/:encounterId/prescriptions` | Issued prescription lines and the No Medication conclusion, if any |
| `POST /api/encounters/:encounterId/prescriptions` `{ lines }` | Issues the whole prescription atomically after a confirmed Diagnosis (201). A penicillin-class line for a penicillin-allergic patient: `409 MEDICATION_ALLERGY_CONFLICT`, nothing issued, no override. A cephalosporin needs `override { reason, note ≥4 chars }` per line (`422 medication-override-required`). `409 no-medication-conflict` against a recorded 无需用药 |
| `POST /api/encounters/:encounterId/no-medication` | Records 无需用药 (201); requires a confirmed Diagnosis and refuses while prescriptions exist (`409 no-medication-conflict`) |
| `POST /api/encounters/:encounterId/consultation/patient-turns/:turnId/speech` `{ text }` | Repairs Sambert WAV for text already streamed by the Simulated Patient. Request cancellation drops synthesis. Frozen Encounters refuse playback. |
| `GET /api/encounters/:encounterId/patient/socket` | WebSocket: the Simulated Patient's reply stream (`src/shared/agent-wire.ts`). Send `{ "type": "hello", "afterSeq": n }`; the server replays events after `n`, sends `replay.done`, then live events; `run.settled` follows once the workspace has the reply. `426` without an upgrade |
| `GET /api/voice` | Which recognizer turns speech into questions: `paraformer-realtime-v2` with a `BAILIAN_TOKEN`, else the browser's Web Speech API |
| `GET /api/encounters/:encounterId/voice` | WebSocket: the doctor's voice capture for an active Encounter (`src/shared/voice.ts`, the `agents/voice` protocol); `426` without an upgrade, `409 encounter-not-active` once frozen |

The workbench shows the same five Completion Gates in the patient banner and action bar. Investigation
and Prescription drafts are saved on the Encounter and count toward the pending-draft gate. The
`POST /api/encounters/:id/completion` command checks all gates in one transaction and returns failed gate
IDs with HTTP 409 on refusal. Completion freezes clinical writes and unlocks the read-only
`GET /api/encounters/:id/debrief` comparison. The replay action starts a fresh Encounter for the same
Golden Case.

Two Worker-seam tests enumerate the Hono app's routes and fail until a new route is listed:

- `test/worker/truth-isolation.test.ts` probes every route for Case Truth with the shared denylist in `test/worker/case-truth.ts` (`expectNoCaseTruth`), which later tickets reuse for WebSocket frames, Simulated Patient replies and Copilot context.
- `test/worker/write-freeze.test.ts` sends every write command under `/api/encounters/:encounterId` to abandoned and completed Encounters and expects `409 encounter-not-active`.

WebSocket routes must be registered on the same Hono app (not dispatched beside it in `src/worker/index.ts`), so the enumeration sees them.

| Script           | What it does                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm dev`       | Local dev server (pass `--port <n>` to change the port)                                          |
| `pnpm build`     | Builds the client assets and the Worker into `dist/`                                             |
| `pnpm typecheck` | `tsc -b` over the web, Worker and tooling projects                                               |
| `pnpm test`      | Local provider transport (`dev`), `worker` (Workers Vitest pool, real Hono + Durable Object + SQLite) and `web` (jsdom + Testing Library, real router + workbench, fetch stubbed) |
| `pnpm test:e2e`  | Builds the app and runs the Chromium encounter journeys with Playwright. |
| `pnpm cf-typegen`| Regenerates `src/worker/worker-configuration.d.ts` after changing `wrangler.jsonc`               |

Run one seam with `pnpm test --project worker` or `pnpm test --project web`.

## Layout

- `src/worker/` Hono app (`app.ts`), Worker entry (`index.ts`), `ClinicWorkspaceDO`, and repositories over its SQLite store.
  - `durable-agent/` The in-repo durable agent runtime: runs queued by commands and executed by the Durable Object alarm, LLM steps checkpointed in the agent's SQLite, crash recovery on the next alarm, per-run deadlines, an event log replayed to hibernatable WebSockets, and an outbox that delivers a run's outcome to the workspace at least once. Domain-agnostic; agents plug in through `AgentDefinition`.
  - `llm/` Provider-neutral LLM types, the OpenAI-compatible streaming adapter, per-agent configuration, and the scripted-provider hook the Worker-seam tests install (`LLM_PROVIDER=scripted`).
  - `simulated-patient/` `SimulatedPatientDO` (one per Encounter) and its context: Patient Persona, doctor utterances and its own settled replies, nothing else. It never imports the Golden Case pack.
- `src/web/` React app: TanStack Router routes (`router.tsx`), workbench components, styles and tokens.
- `src/shared/` Types shared by the API and the browser.
- `data/` Pinned data snapshots. `data/provenance.json` records each snapshot's source paths and reference commit.
- `test/worker/`, `test/web/` The two test seams. `test/fixtures/` holds shared Golden Case expectations.
- `prototypes/copilot-workbench/` Reference prototype, not production code.
- `apps/patient-miniapp/` Native WeChat MiniProgram scaffold (`glass-easel`, `tdesign-miniprogram@1.18.0`, `easyjssdk@2.0.5`, native wire transport).
- `infrastructure/wukongim/` Version-pinned WuKongIM `v2.2.5-20260422` Docker Compose & runbook.
- `data/demo-clinic/` Deterministic synthetic fixtures for Connected Clinic demo seeding and reset.

### Connected Clinic (Issue #45 — S0 & S1)

Connected Clinic runs on the same Worker and `ClinicWorkspaceDO` SQLite runtime isolated by `CLINIC_MODE=connected` (namespace `connected-clinic`; Phase 1 simulation remains the default on `default`). See `docs/adr/0004-connected-clinic-s0-poc-and-stack.md`, `docs/adr/0005-connected-clinic-auth-and-workspace-isolation.md`, `.env.example`, and `infrastructure/wukongim/README.md`.

- **Local WuKongIM**: `docker compose -f infrastructure/wukongim/docker-compose.yml up -d` (HTTP management API loopback-only on `127.0.0.1:15001`, WS on `127.0.0.1:15200`).
- **Auth & Portal routes**: `POST /api/auth/wechat` (invite-code demo binding), `POST /api/auth/staff`, `GET /api/me`, `POST /api/auth/logout`, `GET /api/clinic/departments`, `GET /api/clinic/doctors`, `GET /api/contacts`, `GET /api/patient/records[/:id]`, `GET /api/patient/reports[/:id]`, `GET /api/patient/prescriptions`, and dev/test-only `POST /api/demo/reset` (`DEMO_RESET_ENABLED=true`).
- **External real-device prerequisites**: WeChat MiniProgram AppID, public HTTPS/WSS domains, and iOS/Android physical devices are required before real-device P0 acceptance can be checked off.

### Browser verification

Install Chromium once with `pnpm exec playwright install chromium`, then run `pnpm test:e2e`. Each browser journey starts its own local Worker and Durable Object SQLite store. An HTTP fixture supplies streaming model responses and usage to the normal provider adapter. The browser uses the built client, clinic API and WebSockets. Screenshots and failure traces are written to `.scratch/browser-tests/`.

The workbench takes its light and dark palettes, four-region desktop layout and clinical note form from the [in-repo prototype](prototypes/copilot-workbench/workbench-prototype.html). The Copilot session uses folded tool calls, a scroll-following transcript and a compact mobile composer. Its 上下文 tab and `/上下文` command show the current encounter's context composition, request timeline, item browser and compaction history. The interaction references were [Pi Web](https://github.com/agegr/pi-web), [Pi Pocket](https://github.com/TannerMidd/pi-pocket) and [dsh-context](https://github.com/bowenliang123/dsh-context).
