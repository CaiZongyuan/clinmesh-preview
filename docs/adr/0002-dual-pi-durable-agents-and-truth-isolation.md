---
status: accepted
---

# Isolated Durable Object Agents with UI-SDK Draft-Only Autonomy

Both `Clinical Copilot` and `Simulated Patient` run as separate, per-Encounter Durable Object agents using the in-repo runtime (`ClinicalCopilotDO` and `SimulatedPatientDO`) rather than a single shared agent or a stateless prompt wrapper. `SimulatedPatientDO` is bound strictly to the encounter's immutable `Patient Persona` (its context is the persona, the doctor's utterances and its own settled replies) and never receives copilot reasoning or hidden `Case Truth` lab/diagnosis answers; `ClinicalCopilotDO` observes patient profile, consultation transcript, and live HIS state, and operates the UI exclusively through `@ui-sdk/react` (`createAgent`) to update `Draft` state with animated halo feedback while every formal clinical commit (`Confirm Diagnosis`, `Issue Investigation`, `Issue Prescription`, `Confirm No Medication`, `Acknowledge Report`, `Sign Clinical Note`, `Complete Encounter`) is gated by `data-agent-confirm` for explicit doctor approval.

## Consequences

- Physical DO separation enforces ClinMesh's `no-truth-leak` invariant at the storage and context boundary: neither the doctor nor `Clinical Copilot` can bypass clinical investigation to read `Case Truth`.
- Both agents share the runtime in `src/worker/durable-agent/`. It executes runs on Durable Object alarms, checkpoints LLM steps in SQLite, replays events to hibernatable WebSockets, and delivers workspace outcomes through a durable outbox.
- `Clinical Copilot` must never be granted direct backend mutation tools for formal clinical commits; formal commits always traverse doctor-confirmed UI/command paths.
- `Physical Examination` controls are agent-gated with `data-agent-confirm` because each one reveals `Case Truth` as the doctor's own act, even though an examination is not a formal Clinical Confirmation commit: the doctor's own press needs no dialog or acknowledgement, but `Clinical Copilot` cannot examine without the doctor's approval.
