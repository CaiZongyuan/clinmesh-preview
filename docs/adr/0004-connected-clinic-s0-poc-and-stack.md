---
status: accepted
---

# Connected Clinic S0 Technology Stack, Compatibility Matrix, and Fallback Rules

For Issue #45 (`ClinMesh Connected Clinic`), we ran source-level and live-container P0 verification before building slices S1–S8. We retain Cloudflare Workers + Hono + `ClinicWorkspaceDO` SQLite and the in-repo durable agent runtime (`src/worker/durable-agent/`), select **WuKongIM `v2.2.5-20260422`** with **`easyjssdk@2.0.5`** for real IM transport (with HIS owning read cursors and send idempotency/compensation), and **reject `@cloudbase/agent-ui-miniprogram@0.0.24`** in favor of a zero-dependency native WeChat MiniProgram `Behavior` + `wx.connectSocket` + pure TypeScript reducer (`src/shared/agent-stream-reducer.ts`) directly speaking ClinMesh's versioned `src/shared/agent-wire.ts` protocol. Real-device iOS/Android, `wx.login` production `code2Session`, TLS/WSS domain, and Skyline rendering remain explicitly pending external prerequisites (WeChat AppID, public HTTPS/WSS domain, physical test devices) and are NOT claimed as verified.

## P0 Compatibility Matrix (Verified 2026-11-26)

| Component | Locked Version / Digest | License | Entry / Build | S0 Verification Result | Decision & Fallback |
|---|---|---|---|---|---|
| **WuKongIM Server** | `v2.2.5-20260422` (`registry.cn-shanghai.aliyuncs.com/wukongim/wukongim:v2@sha256:aaa2b3c0f7501083b44ee7414517dbcf7ff906aa049a1ed5c4e764ae4f05b65f`) | Apache-2.0 | Docker (`infrastructure/wukongim/docker-compose.yml`), `mode: release`, `tokenAuthOn: true`, `WK_MANAGERTOKEN` | **PASS (local Docker)**: HTTP management API returns `401` without `token`; `POST /user/token`, `POST /channel`, `POST /channel/subscriber_remove`, `POST /user/device_quit`, `POST /message/send`, `POST /channel/messagesync` all verified live. **CRITICAL FINDING**: `POST /message/send` does **not** deduplicate repeated `client_msg_no` (creates seq 1 & seq 2) and returns 64-bit integer `message_id` (loses precision in JS `JSON.parse`). | **Accept** with mandatory HIS-owned `send_command` idempotency + `/channel/messagesync` reconciliation + raw string parsing for 64-bit `message_id`. Fallback if real-device WSS fails: OpenIM (never mix both). |
| **WuKongIM Client SDK** | `easyjssdk@2.0.5` | ISC | `"miniprogram": "dist/cjs"`, `"types": "dist/esm/index.d.ts"`, 0 required runtime deps (`ws` optional for Node) | **PASS (live Node vs WuKongIM v2.2.5)**: Auth rejection blocks connect; non-member send resolves with `reasonCode: 3` (`SubscriberNotExist`, `messageSeq: 0`); live `subscriber_remove` immediately blocks sends (`reasonCode: 3`) and stops push delivery (`delta: 0`); `device_quit` kicks socket (`reasonCode: 12`) and rotated token blocks old token reconnect. **WATCHPOINT**: `dist/cjs/index.js:366` contains `new Function('mod', 'return require(mod)')` inside the Node.js-only branch. No built-in read-cursor/unread store. | **Accept** for Web & MiniProgram POC; callers MUST inspect `result.reasonCode === 1` (SDK resolves on send refusal). HIS (`conversation_member.last_read_seq`) is the single authority for read cursors/unreads. If WeChat DevTools/real-device CSP flags line 366, strip the Node branch or replace with a thin `wx.connectSocket` WuKongIM JSON-RPC adapter. |
| **CloudBase MiniProgram Agent SDK** | `@cloudbase/agent-ui-miniprogram@0.0.24` | MIT | `dist/index.cjs.js` (52 KB, no `miniprogram` field in `package.json`) | **FAIL (source-level architectural mismatch)**: (1) No `stop()`/`abort()` API on `AGUINamespace`; (2) `__aguiExecuteToolCall` treats every `TOOL_CALL_END` as a mandatory client tool and marks unregistered server tools (`list_available_slots`, `list_my_medical_records`, etc.) as `TOOL_NOT_FOUND` failed before recursively re-invoking the agent; (3) no `run.reset`, `afterSeq` replay, `resync`, or `run.settled` reconciliation; (4) `_aguiSendMessage` and `__aguiUpdateToolCallStatus` pass full `uiMessages` arrays to `setData`. | **Reject**. Use native MiniProgram `Behavior` + `wx.connectSocket` + `src/shared/agent-stream-reducer.ts` directly consuming `src/shared/agent-wire.ts` with path-level `setData` (`stream.runs.<id>.text`), `hello { afterSeq }` replay, `run.reset` discard, `stop()`, and strict whitelisted client action registry. |
| **MiniProgram UI & Typings** | `tdesign-miniprogram@1.18.0`, `miniprogram-api-typings@5.3.1`, `miniprogram-simulate@1.7.0` | MIT | Native TS/WXML/WXSS (`apps/patient-miniapp/`), `glass-easel` component framework | **Registry & scaffold verified**; Skyline real-device rendering & `Build npm` in WeChat DevTools pending external AppID & physical devices. | **Accept** with `glass-easel` default and WebView renderer fallback per page if Skyline exhibits list/input/audio issues on device. |
| **HIS Backend & Agent Runtime** | Cloudflare Workers + Hono `4.13.21` + `ClinicWorkspaceDO` SQLite + `src/worker/durable-agent/` | In-repo | Existing single-runtime Worker | **PASS**: Existing 42 test suites remain green; zero DB migration to external SQL required. | **Retain**; add Connected Clinic workspace namespace isolation and auth/RBAC in S1. |

## Key S0 Architectural Decisions

### 1. Send Idempotency & Uncertain-State Compensation (No False "Exactly-Once")
Because live testing proved WuKongIM `v2.2.5` `POST /message/send` appends a second message when called twice with the same `client_msg_no`:
- `ClinicWorkspaceDO` owns a durable `send_command` table keyed by `UNIQUE (conversation_id, client_message_id)`.
- Re-submitting an already `sent` `client_message_id` returns the stored `external_message_id` and `sequence` immediately without touching WuKongIM.
- If a command is left in `sending` (crash/network timeout after HTTP dispatch), recovery MUST first call `POST /channel/messagesync` for the channel tail and match `client_msg_no === client_message_id`; if present, settle from IM truth without resending. Only if absent may recovery retry, and clients deduplicate by `(messageId, clientMessageId)`.
- The WuKongIM adapter extracts 64-bit `message_id` digits from the raw HTTP JSON response before `JSON.parse` (or reads `message_id_str` when present) so snowflake IDs are never rounded by IEEE-754 doubles.

### 2. Single Authority for Read Cursors & Membership
- `easyjssdk@2.0.5` is a transport SDK without a read-cursor store. Therefore **`ClinicWorkspaceDO` (`conversation_member.last_read_seq`) is the single authoritative owner** of read positions and unread counts; there is no dual-write with IM.
- `ClinicWorkspaceDO` owns canonical conversation membership; WuKongIM channel subscribers are a projection. Pending members (`status = 'pending'`) are not granted read/write access; revoking a member updates HIS state first, calls `/channel/subscriber_remove`, and on logout calls `/user/device_quit` + token rotation.

### 3. Native Agent Wire Reducer over CloudBase AG-UI SDK
- `src/shared/agent-stream-reducer.ts` consumes `src/shared/agent-wire.ts` directly, emits minimal path-based `setData` patches (`stream.runs.<runId>.text`, `stream.runs.<runId>.tools[i].status`), strips `thinking.delta`, handles `run.reset` and `resync`, reconciles `run.settled`, and validates client UI actions against a strict ID-checked whitelist (`medical.record.open`, `report.open`, `appointment.open`, `followup.open`).
- No Tencent CloudBase backend (`wx.cloud.extend.AI`) is introduced.

## Pending External P0 Acceptance Items (Blocked on Team Prerequisites)

The following items are **NOT marked complete** until external credentials/devices are provided:
- [ ] WeChat MiniProgram AppID & project member permission configured in `apps/patient-miniapp/project.config.json` (currently placeholder `wx0000000000000000` for local typecheck/tooling).
- [ ] Real `wx.login` → `POST /api/auth/wechat` → Tencent `jscode2session` exchange on physical iOS and Android devices (local/test uses injectable WeChat verifier seam).
- [ ] Public HTTPS/WSS domain with valid TLS certificate registered in WeChat MiniProgram `request合法域名` / `socket合法域名` / `uploadFile合法域名` / `downloadFile合法域名`.
- [ ] Physical iOS + Android verification of WeChat DevTools `Build npm` (`tdesign-miniprogram@1.18.0`, `easyjssdk@2.0.5`), Skyline vs WebView renderer on long streaming chat lists, foreground/background `onShow` reconnect, and `wx.getRecorderManager` audio upload/playback.
