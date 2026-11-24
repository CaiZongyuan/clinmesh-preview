---
status: accepted
---

# Dual Isolated Pi Durable Agents with UI-SDK Draft-Only Autonomy

Both `Clinical Copilot` and `Simulated Patient` run as separate, per-encounter `pi-durable` Durable Object agents (`ClinicalCopilotDO` and `SimulatedPatientDO`) rather than a single shared agent or a stateless prompt wrapper. `SimulatedPatientDO` is bound strictly to the encounter's immutable `Patient Persona` and never receives copilot reasoning or hidden `Case Truth` lab/diagnosis answers; `ClinicalCopilotDO` observes patient profile, consultation transcript, and live HIS state, and operates the UI exclusively through `@ui-sdk/react` (`createAgent`) to update `Draft` state with animated halo feedback while every formal clinical commit (`Confirm Diagnosis`, `Issue Investigation`, `Issue Prescription`, `Confirm No Medication`, `Acknowledge Report`, `Sign Clinical Note`, `Complete Encounter`) is gated by `data-agent-confirm` for explicit doctor approval.

## Consequences

- Physical DO separation enforces ClinMesh's `no-truth-leak` invariant at the storage and context boundary: neither the doctor nor `Clinical Copilot` can bypass clinical investigation to read `Case Truth`.
- Both agents inherit crash recovery, durable transcripts, and WebSocket reconnection from `pi-durable` without custom session plumbing.
- `Clinical Copilot` must never be granted direct backend mutation tools for formal clinical commits; formal commits always traverse doctor-confirmed UI/command paths.
