# ClinMesh Preview

Agentic Mini HIS for single-doctor outpatient Encounters. See `GLOSSARY.md` for domain terms and `docs/adr/` for architecture decisions.

## Run it

Requires Node 24+ and pnpm 12.

```sh
pnpm install
pnpm dev         # Vite + Cloudflare Workers runtime: http://localhost:5173
```

`pnpm dev` serves the workbench page and the Worker API from one origin, with `ClinicWorkspaceDO` running locally on embedded SQLite (state under `.wrangler/`). Try `curl http://localhost:5173/api/golden-cases`.

### HTTP API

Request and response shapes live in `src/shared/`. Errors answer `{ "error": { "code", "message" } }`.

| Route | What it does |
| ----- | ------------ |
| `GET /api/golden-cases` | The queue; `queueStatus` is `in-encounter` while a Golden Case has the active Encounter |
| `POST /api/encounters` `{ caseId }` | Starts an Encounter (201); `409 active-encounter-exists` while another is active |
| `GET /api/encounters/active` | The workspace's active Encounter, or `null` |
| `GET /api/encounters/:encounterId` | One Encounter: patient banner, triage vitals and Visible Source History only |
| `POST /api/encounters/:encounterId/abandonment` | Encounter Abandonment; `409 encounter-not-active` once it is frozen |
| `GET /api/encounters/:encounterId/audit-events` | Audit trail with `practitionerId` |

Every new HTTP or WebSocket route must be added to the probe table in `test/worker/truth-isolation.test.ts`, which fails until it is.

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
- `src/web/` React app: TanStack Router routes (`router.tsx`), workbench components, styles and tokens.
- `src/shared/` Types shared by the API and the browser.
- `data/` Pinned data snapshots. `data/provenance.json` records each snapshot's source paths and reference commit.
- `test/worker/`, `test/web/` The two test seams; `test/fixtures/` holds what both seams expect of Golden Case 1.
- `prototypes/copilot-workbench/` Reference prototype, not production code.
