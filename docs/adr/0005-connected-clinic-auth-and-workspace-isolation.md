---
status: accepted
---

# Connected Clinic Auth, Transactional RBAC, and Workspace Namespace Isolation

Connected Clinic runs on the same Cloudflare Worker and `ClinicWorkspaceDO` codebase as the Phase 1 outpatient simulation MVP, isolated by an explicit workspace mode and Durable Object namespace (`CLINIC_MODE=connected` → workspace `connected-clinic`, versus Phase 1 default `CLINIC_MODE=simulation` → workspace `default`). All formal clinical writes, patient portal projections, and session validations enforce actor identity and role eligibility inside the `ClinicWorkspaceDO` SQLite transaction that mutates or reads state, eliminating TOCTOU gaps between Hono route checks and DO execution.

## Key Decisions

- **Opaque hashed bearer sessions**: `POST /api/auth/staff` and `POST /api/auth/wechat` return an opaque 256-bit bearer token and persist only its SHA-256 hex digest in `auth_session.token_hash`. Staff passwords and patient demo invite codes are salted SHA-256 hashes; temporary WeChat `wx.login` codes and `session_key` values are never persisted or returned.
- **One-time WeChat demo identity binding**: First-time WeChat login requires a valid, unexpired, unbound demo invite code to link `account(provider='wechat', provider_subject=openid)` to a stable diagnosis-neutral `patient_id`. Repeat logins with the same `openid` always resolve to the bound patient and cannot rebind or hijack another patient's invite code.
- **Role boundary on clinical routes**: Patients (`role='patient'`) are strictly blocked (`403 forbidden`, audited) from every legacy clinical HTTP and WebSocket route (`/api/golden-cases`, `/api/encounters/*`, `/debrief`, `/copilot/*`, `/patient/socket`, `/voice`) regardless of `CLINIC_MODE`, and access only `/api/patient/*` projections derived strictly from `patient_release` rows owned by `principal.patientId` with `retracted_at IS NULL`. Nurses may read authorized clinical state but are refused (`403`) on doctor-only formal clinical mutations both at Hono and inside `ClinicWorkspaceDO` transactions.
- **Real practitioner attribution**: Authenticated doctors pass their verified `staff_id` (`staff_doctor_a`, `staff_doctor_b`) into every clinical command and audit event, replacing `DEMO_PRACTITIONER_ID` in Connected Clinic mode while preserving Phase 1 simulation mode backward compatibility.
- **Gated demo reset**: `POST /api/demo/reset` is refused (`403 demo-reset-disabled`) unless `DEMO_RESET_ENABLED='true'` is explicitly configured for dev/test environments, and atomically wipes sessions, account bindings, and active clinical drafts before re-seeding `data/demo-clinic/seed-manifest.json`.
