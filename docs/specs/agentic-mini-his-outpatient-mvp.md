# Spec: ClinMesh Preview — Agentic Mini HIS (Phase 1 Outpatient Encounter MVP)

> Tracked as [#1](https://github.com/CaiZongyuan/clinmesh-preview/issues/1). Reference prototype: `prototypes/copilot-workbench/workbench-prototype.html`.

## Problem Statement

Clinicians in outpatient practice spend disproportionate attention clicking through electronic medical record forms—transcribing symptoms, copying histories, drafting lab orders, staging diagnoses, and assembling structured notes—instead of focusing on the patient in front of them. Conversely, naive AI chatbots bolted onto a medical record either force the doctor to manually copy-paste suggestions or dangerously blur the line between unverified AI text and legally accountable clinical records. Meanwhile, teams building and evaluating agentic clinical workflows lack a lightweight, reproducible outpatient HIS workbench that enforces real clinical invariants (truth isolation during patient interviews, allergy red-lines, report revision re-acknowledgement, server-verified encounter completion gates) without dragging in heavy multi-department hospital infrastructure.

## Solution

Build **ClinMesh Preview**, a lightweight Agentic Mini HIS focused on a single-doctor outpatient **Encounter** loop with an ambient **Clinical Copilot** and a realistic **Simulated Patient**.

The doctor opens the outpatient workbench without logging in, picks one of four **Golden Cases** from the queue, and conducts a spoken or typed **Consultation** with the **Simulated Patient** in a dedicated, resizable Consultation column. Speech is captured either hands-free (持续收音, with automatic sentence segmentation and a visible privacy pause) or push-to-talk (按住说话, hold the button or Space). Live Chinese captions finalize into the transcript; the **Simulated Patient** answers only from its version-fixed **Patient Persona**, streaming text and interruptible Chinese speech, and never reveals **Case Truth**. Objective findings come from an explicit **Physical Examination** and from **Investigations**, not from the patient's mouth.

The **Clinical Copilot** is a durable agent session shown in a right-hand panel that reads like a desktop AI chat. Each automatic analysis appears as a turn triggered by a clinical event (a finalized consultation turn, a completed examination, a released or amended **Report**), with folded thinking and tool steps and a short summary. It writes only **Drafts** into the case workspace—highlighted with an animated halo—never overwrites what the doctor has edited (those changes become **Suggestions** to accept or dismiss), and cannot press any formal button. The doctor can also ask it questions directly, and a context view shows exactly what the Copilot can see, including that **Case Truth** is not in it.

Every formal clinical decision—confirming a **Diagnosis**, issuing an **Investigation**, acknowledging a **Report**, issuing a **Prescription** or recording **No Medication**, signing the **Clinical Note**, completing or abandoning the **Encounter**—requires explicit **Clinical Confirmation** and atomic server-side verification. When all five **Completion Gates** pass, the **Encounter** freezes and unlocks a read-only **Case Debrief**.

## User Stories

### Encounters and Golden Cases

1. As an outpatient doctor, I want to open the workbench directly without registration or multi-role login, so that I can start practicing or demonstrating outpatient encounters immediately.
2. As an outpatient doctor, I want a queue of the four **Golden Cases** showing queue number, name, sex, age, chief complaint, registration time, and first-visit/return-visit status, grouped into 在诊 / 待诊 / 完诊, so that I can choose a realistic scenario to work through.
3. As an outpatient doctor, I want to start an **Encounter** for a selected **Golden Case** and see only the patient's **Visible Source History** (prior visits, allergies, chronic conditions, prior medications) and triage vitals, so that my reasoning mirrors real practice without seeing hidden answers.
4. As an outpatient doctor, I want hidden **Case Truth** (true diagnosis, unrevealed examination and investigation results, debrief notes) to be inaccessible across UI and API while an **Encounter** is active, so that neither I nor the **Clinical Copilot** can shortcut the diagnostic process.
5. As an outpatient doctor, I want a patient banner with allergy badges in the critical color, chronic-condition badges, triage level, outpatient number (copyable), registration time, chief complaint, vitals tiles that flag abnormal values, an encounter timer, and a 健康档案 popover, so that safety-critical context is always in view.
6. As an outpatient doctor, I want exactly one active **Encounter** per workspace, and to record **Encounter Abandonment** with **Clinical Confirmation** to leave an unfinished one—freezing it without unlocking **Case Truth**—so that encounter state stays unambiguous.
7. As an outpatient doctor, I want to start a fresh, independent **Encounter** for the same **Golden Case** after completion without overwriting prior encounters, so that I can replay cases and compare runs.

### Consultation and voice

8. As an outpatient doctor, I want to converse with the **Simulated Patient** by voice or typed text inside a sequential **Consultation** stream, so that I can elicit chief complaint, symptom evolution, history, and red flags naturally.
9. As an outpatient doctor, I want the system to refuse a second question while my previous question is still awaiting a reply, so that the **Consultation** keeps a clean, auditable turn order.
10. As an outpatient doctor, I want a patient turn that errors or exceeds ~30s to be marked failed, release the pending-turn lock, stay in the record for audit, and offer a one-click retry, so that a stuck model never deadlocks the interview.
11. As an outpatient doctor, I want the **Simulated Patient** to answer strictly from its version-fixed **Patient Persona** in lay language without naming undiagnosed conditions or leaking result values, so that clinical discovery feels authentic.
12. As an outpatient doctor, I want a **持续收音** mode that I toggle on and off (also with `M`), segments my speech into sentences automatically, and shows live interim captions that finalize into the transcript, so that I can interview hands-free.
13. As an outpatient doctor, I want a **按住说话** mode where I hold the button or the Space key to speak, see an elapsed timer and level meter, slide up to cancel, and get a "too short" notice for accidental taps, so that I control exactly what is captured.
14. As an outpatient doctor, I want pausing the microphone to show a persistent banner stating that private remarks are not written into the **Consultation**, so that I trust the pause.
15. As an outpatient doctor, I want the patient's reply to stream as text with optional Chinese speech playback (with a progress bar, a mute toggle, and replay), and playback to stop the moment I start speaking—marking the turn "播放已打断"—so that the conversation flows naturally.
16. As an outpatient doctor, I want each turn to show speaker, time, whether it was spoken or typed, speech duration and recognition confidence, and the panel to show speech-recognition connection state, latency, and the selected microphone, so that I can judge transcript reliability.
17. As an outpatient doctor, I want a typed-question fallback in the same column, so that I can keep working when speech is inconvenient or unavailable.
18. As an outpatient doctor, I want to perform a **Physical Examination** by body system (vitals, general, pharynx, lungs, heart, abdomen) and receive findings instantly and deterministically from **Case Truth**, shown inline in the transcript as objective findings, so that signs come from examination rather than patient self-report.
19. As an outpatient doctor, I want to copy a turn or quote it into any **Clinical Note** section (with undo), so that the patient's own words can support documentation.
20. As an outpatient doctor, I want to filter the transcript (all / doctor / patient / examination) and jump back to the latest turn after scrolling up, so that long interviews stay navigable.
21. As an outpatient doctor, I want to widen, narrow, or collapse the Consultation column—collapsed state still showing recording and waiting indicators—so that I can trade transcript space for workspace space.
22. As an outpatient doctor, I want the transcript, drafts, and agent sessions to survive page refreshes and transient network drops, so that I never lose clinical progress mid-encounter.

### Clinical Copilot

23. As an outpatient doctor, I want the **Clinical Copilot** to analyze automatically after a finalized consultation turn (with a visible ~1.2s countdown I can skip or trigger immediately), a completed **Physical Examination**, a released **Report**, or a **Report** amendment, so that documentation stays current without prompting.
24. As an outpatient doctor, I want to switch automatic analysis off, have events accumulate as "待分析", and run them together on demand, so that I control when the assistant works.
25. As an outpatient doctor, I want the **Clinical Copilot** to populate **Draft** content in the six-section **Clinical Note**, candidate **Investigations**, candidate **Diagnoses**, and **Prescription** drafts, so that I rarely type repetitive entries.
26. As an outpatient doctor, I want an animated halo on the exact card, field, or tab the **Clinical Copilot** is changing (static under reduced motion), so that ambient automation stays transparent even when I'm on another tab.
27. As an outpatient doctor, I want Copilot-written draft fields marked with a dashed border and a "助手" badge that disappears once I edit them, so that I always know who wrote what.
28. As an outpatient doctor, I want any **Draft** field or line I am focusing or have edited to be protected from overwrites, with the Copilot's change shown as a **Suggestion** both inline and as an approval card in its session, accepted or dismissed with one click (and accept undoable), so that I keep authorship.
29. As an outpatient doctor, I want the **Clinical Copilot** to be physically unable to execute formal commits, and any attempt to show as "被拦截" in its session, so that nothing enters the official record without my approval.
30. As an outpatient doctor, I want the Copilot panel to show each turn as a trigger row or my prompt, followed by folded thinking (streamed while running), tool steps with status, duration and expandable arguments/results, a streamed summary reply, and a usage line, so that I can audit what it did and why.
31. As an outpatient doctor, I want to ask the **Clinical Copilot** questions, use slash commands (/鉴别诊断, /检查建议, /用药核查, /病历小结, /上下文), and @-mention HIS objects (released **Reports**, note sections, examination findings, drafts), so that I can direct its attention precisely.
32. As an outpatient doctor, I want to stop a running turn (button or Esc)—keeping drafts already written and saying so—and, while it runs, choose to steer (read before its next step) or queue (after this turn), with queued items visible, so that I stay in control of a busy assistant.
33. As an outpatient doctor, I want per-reply actions to copy, regenerate, edit-and-resend my prompt, and mark helpful or not, so that I can iterate quickly and leave feedback.
34. As an outpatient doctor, I want a model chip to choose the model and thinking effort for this session (defaults from environment configuration), so that I can trade speed for depth.
35. As an outpatient doctor, I want a 上下文 view showing context usage against the window, a category breakdown (system prompt, tool definitions, patient visible data, consultation, HIS state & UI snapshot, replies & thinking, tool results) with reserve, per-request timeline and deltas, an itemized browser, an explicit "Case Truth · 0 tokens · isolated" row, and a manual compaction action that leaves a marker in the session, so that I can verify what the assistant sees.
36. As an outpatient doctor, I want the Copilot panel visible by default, resizable, and hideable—with the top bar then showing its status and unread count—and Ctrl+/ to focus its input, so that it is available without crowding the workspace.
37. As an outpatient doctor, I want a top-bar status summarizing the assistant (running and what it's doing, countdown, items awaiting confirmation, events awaiting analysis, reconnecting, ready), so that I can glance at it without opening the panel.
38. As an outpatient doctor, I want the session to show connection state and, after a drop, resume from its latest durable checkpoint with a notice, so that interruptions don't lose assistant work.

### Investigations and Reports

39. As an outpatient doctor, I want to build an order from a curated catalog searchable by name or pinyin initials, filterable by 检验 / 放射 / 功能, showing specimen, performing department and expected turnaround, into a pending list I can edit, and issue it with **Clinical Confirmation**, so that ordering is fast and deliberate.
40. As an outpatient doctor, I want issued **Investigations** to resolve deterministically from **Case Truth** or catalog baseline rules after a brief simulated turnaround, with per-order progress stages and timestamps (检验: 已开立 → 已采样 → 检验中 → 已出报告; 放射: 已开立 → 已登记 → 检查中 → 待审核 → 已出报告; 功能: 已开立 → 检查中 → 已出报告) and an instant-release test control, so that results are reproducible and never hallucinated.
41. As an outpatient doctor, I want to cancel an **Investigation** with **Clinical Confirmation** only before its first **Report** is released, so that orders can't be silently withdrawn after results exist.
42. As an outpatient doctor, I want each **Report** to show version, reporter and reviewer, report time, specimen or body site, and for labs a 项目 / 结果 / 单位 / 参考范围 / 提示 table with ↑/↓ 偏高/偏低 flags and an only-abnormal filter (imaging and ECG as findings plus impression), so that I can read results the way a real HIS presents them.
43. As an outpatient doctor, I want scripted **Report** amendments to create a new version that reopens as unacknowledged, shows its correction reason, and lists superseded versions with their earlier acknowledgements, so that corrections are never missed.
44. As an outpatient doctor, I want to perform **Report Acknowledgement** explicitly on the latest version—singly or for several at once—recording time and doctor, rather than having viewing count, so that responsibility is auditable.

### Diagnosis

45. As an outpatient doctor, I want to search ICD-10 by name, code, or pinyin with keyboard selection, add common diagnoses in one click, set exactly one primary via a radio choice (maximum eight entries), and confirm with **Clinical Confirmation**, so that diagnostic accountability stays rigorous.
46. As an outpatient doctor, I want confirmed **Diagnosis** revisions kept as history and revising after the **Clinical Note** was signed to mark that signature as predating the current diagnosis (requiring a new signed revision) while existing **Prescriptions** stay valid for me to reassess, so that records stay coherent.

### Prescription

47. As an outpatient doctor, I want to search the formulary by name, pinyin, or class, see "与过敏史冲突" or "交叉过敏风险" tags before adding, edit dose, route, frequency, and days with a computed total quantity, and open a package-insert summary, so that prescribing is safe and fast.
48. As an outpatient doctor, I want **Prescriptions** to be issuable only after a confirmed **Diagnosis**, so that therapy always follows a diagnosis.
49. As an outpatient doctor, I want penicillin-class drugs for a penicillin-allergic patient to be hard-refused server-side ("药事安全红线拦截（不可越权）"), with the whole prescription left unissued and no override, so that the safety red line cannot be crossed.
50. As an outpatient doctor, I want a cephalosporin for a penicillin-allergic patient to raise a quality warning that I can pass only by choosing a reason and writing a note of at least four characters, recorded for audit, so that cross-reactivity risk is consciously accepted.
51. As an outpatient doctor, I want to record an explicit **No Medication** conclusion, mutually exclusive with active prescriptions, for self-limiting conditions, so that responsible non-prescribing satisfies completion without an empty prescription.

### Clinical Note and completion

52. As an outpatient doctor, I want the six-section **Clinical Note** (chief complaint, history of present illness, past & allergy history, examination & investigation findings, assessment & rationale, plan & follow-up) with required markers, character counters, common phrases, and a visible autosave state, so that documentation is quick and safe from loss.
53. As an outpatient doctor, I want to sign the **Clinical Note** as an immutable revision, see the signing history, and see badges for unsigned changes or a signature that predates the current diagnosis, so that formal documentation is tamper-evident.
54. As an outpatient doctor, I want an action bar showing completion progress (x/5) with a checklist that links to each unmet gate, and a complete button that looks unready until gates pass, so that I always know what's left.
55. As an outpatient doctor, I want the server to re-verify all five **Completion Gates** atomically when I submit completion and to name the failed gates if it refuses, so that incomplete work cannot close an encounter.
56. As an outpatient doctor, I want the completed **Encounter** to freeze and unlock a read-only **Case Debrief** placing my formal record beside the golden reference (diagnoses, key investigations, examination, medication conclusion, key history questions, severity assessment, disposition) without a score, so that I can review accuracy afterwards.

### Ergonomics and accessibility

57. As an outpatient doctor, I want reversible convenience actions (quoting into the note, accepting a suggestion) to offer undo in their confirmation toast, so that mistakes are cheap.
58. As an outpatient doctor, I want keyboard shortcuts (hold Space to talk, M to pause, Alt+1–4 for tabs, Ctrl+/ for the Copilot, Esc to stop it) listed in a shortcuts popover, so that I can work without the mouse.
59. As an outpatient doctor, I want to choose light/dark/system theme and a 标准 / 大 / 特大 font scale, remembered per browser, so that the workbench suits my environment and eyesight.
60. As a clinician using assistive technology or an agent evaluator, I want every control to have a unique accessible name, proper keyboard and focus behavior (including keyboard-adjustable column separators), and reduced-motion respect, so that humans and the UI agent bridge can reliably operate the interface.

## Implementation Decisions

- **Unified Edge Runtime and Embedded SQLite (ADR-0001)**: The whole backend—HTTP/WebSocket routing, HIS persistence, durable agent loops, voice sessions—runs in one Cloudflare Workers + Durable Objects runtime with Hono. HIS records (patients, case instances, encounters, consultations, drafts, investigations, versioned reports, acknowledgements, diagnosis revisions, prescriptions, no-medication conclusions, signed note revisions, audit log) live in the workspace Durable Object's SQLite (`ClinicWorkspaceDO`) so every clinical command is a single atomic transaction.
- **Dual Isolated `pi-durable` Agents and Truth Isolation (ADR-0002)**: **Simulated Patient** and **Clinical Copilot** run on `pi-durable` in separate per-encounter Durable Objects (`SimulatedPatientDO`, `ClinicalCopilotDO`), each checkpointed to its own SQLite. The patient agent receives only the **Patient Persona** and doctor utterances. The Copilot receives read-only tools for **Visible Source History**, clinic catalogs, formal encounter state, **Physical Examination** findings, and all released **Report** versions (acknowledged or not, so it can prompt for acknowledgement), plus the bridged UI tools—and no tool that reads **Case Truth** or mutates formal records.
- **Default LLM configuration**: Model layer configured by environment variables (OpenAI-compatible, Anthropic, Gemini), with independent overrides for the two agents. Default `glm-5.3-flash` at `low` reasoning effort. The Copilot panel may change model and effort for the current session only.
- **Copilot run model**: Every Copilot analysis is a durable turn. Ambient triggers are: consultation turn finalized (debounced ~1.2s; a newer finalized turn flushes the pending one into the queue), **Physical Examination** completed, **Report** released, **Report** amended. Runs are serialized per encounter. A doctor prompt either steers (inserted ahead of queued runs) or queues. Stop cancels the remaining steps of the current run; drafts already applied stay. With automatic analysis off, triggers accumulate and can be run as one batched turn. Turn shape (from the prototype):
  ```ts
  type CopilotTurn = {
    trigger: { kind: 'event' | 'doctor'; text: string };
    status: 'running' | 'done' | 'stopped';
    steps: Array<
      | { kind: 'think'; text: string; state: 'running' | 'done' | 'stopped'; dur?: number }
      | { kind: 'tool'; name: 'ui_snapshot' | 'ui_act' | 'read_released_reports' | string;
          subject: string; args: unknown; result: string;
          state: 'ok' | 'denied' /* data-agent-confirm */ | 'approval' /* became a Suggestion */; dur: number }
    >;
    reply: string;            // short markdown summary, streamed
    usage: { in: number; out: number };
  };
  ```
- **WebSocket `ui-sdk` bridge, Drafts and Suggestions**: The browser keeps the `@ui-sdk/react` `createAgent()` bridge connected to `ClinicalCopilotDO`. Each run starts with a `ui_snapshot` that includes focused and doctor-edited targets. `ui_act` on a safe target applies the **Draft** and lights the halo on the field, card, and tab; `ui_act` on a target the doctor edited or is focusing—or on a draft module the doctor has touched—does not apply and instead creates a **Suggestion** carrying its apply action and originating turn; any `ui_act` on a `data-agent-confirm` control is refused and recorded as intercepted. **Draft** mutations debounce-sync to `ClinicWorkspaceDO` so refreshes preserve them, and the UI shows the autosave state.
- **Completion Gates**: Evaluated live in the UI and re-evaluated atomically on the server when completing. Gate logic (from the prototype):
  ```ts
  gate1 = lastDiagnosisRevision?.items.filter(i => i.primary).length === 1;
  gate2 = issuedInvestigations                       // ordered or released, not cancelled
            .every(i => i.released && i.latestReport.acknowledged);
  gate3 = issuedPrescriptions.length > 0 || noMedication;
  gate4 = lastSignedNote && (!lastDiagnosisRevision || lastSignedNote.seq > lastDiagnosisRevision.seq);
  gate5 = draftInvestigations + draftDiagnoses + draftPrescriptionLines + pendingSuggestions === 0;
  ```
- **Clinical domain model and invariants**:
  - Four Chinese **Golden Cases**: (1) community-acquired pneumonia with penicillin anaphylaxis history (red line); (2) acute chest pain / NSTEMI workup adapted from the reference repo's authored case `cardio-nstemi-chest-pain-v1` (V2–V5 ST depression, hs-cTnI with a scripted **Report** amendment), whose disposition (urgent transfer / admission) is recorded only in the **Clinical Note** plan and checked in the **Case Debrief**; (3) newly diagnosed type 2 diabetes with UTI requiring primary + secondary diagnoses and two drugs; (4) viral upper respiratory infection validating **No Medication**.
  - Each **Case Truth** holds per-body-system **Physical Examination** findings, per-catalog-item result overrides, and optional scripted **Report** amendments; every other catalog item resolves from an age/sex-banded baseline rule, and items without one are not admitted to the catalog.
  - Single demo practitioner; `practitionerId` recorded on every formal write and audit event.
  - Server commands enforce atomically: single pending doctor turn (released when a turn fails); one active **Encounter** per workspace; cancellation only before the first **Report**; latest-version-only **Report Acknowledgement**; exactly one primary **Diagnosis** per confirmation; **Prescription** only after a confirmed **Diagnosis**; allergy red line; mutual exclusion of **Prescription** and **No Medication**; immutable signed **Clinical Note** revisions and diagnosis-revision staleness; five-gate completion before unlocking **Case Debrief**.
  - **Allergy rules match by drug class, not drug code**: penicillin allergy → penicillin class hard-refused (`MEDICATION_ALLERGY_CONFLICT`, no override); cephalosporin class → quality warning requiring a reason from a fixed list plus a note of ≥4 characters, stored with the issued line.
- **Voice pipeline (ADR-0003)**: Cloudflare `agents/voice` handles audio transport, turn lifecycle and interruption, with two Bailian adapters sharing `BAILIAN_TOKEN`:
  - `ParaformerTranscriber` (`paraformer-realtime-v2`, 16 kHz mono PCM; waits for `task-started`; interim captions from partial results; a finalized sentence on `sentence_end: true`; closes with `finish-task`). Without a token, local development falls back to the browser Web Speech API.
  - `SambertTTSProvider` (`sambert`, one-shot `run-task` with `streaming: "out"`, never sends `finish-task`, repairs streamed WAV sentinel lengths on `task-finished`, `AbortSignal` cancellation for barge-in).
  - Two capture modes share the same transcriber: hands-free with VAD sentence segmentation and a privacy pause, and push-to-talk (hold control or Space; slide-up cancel; sub-600 ms captures discarded). Doctor speech onset cancels patient playback and marks the turn interrupted.
  - Every **Consultation** turn keeps `speaker: 'doctor' | 'patient'` and an attribution seam for Phase 2 dual-human listening and voiceprint verification.
- **Context accounting**: The Copilot exposes a per-request breakdown by category (system prompt, tool definitions, patient visible data, consultation, HIS state & UI snapshot, assistant replies & thinking, tool results), estimated locally and reconciled with provider-reported usage per turn, against the model window minus a compaction/output reserve. **Case Truth** is always listed with zero tokens. Manual compaction summarizes earlier replies and tool results; consultation and HIS state are re-injected each request and are not compacted away.
- **Workbench layout and visual system**: Four regions—queue rail | Consultation column | case workspace card | Clinical Copilot panel. The Consultation and Copilot columns are drag-resizable (keyboard-operable separators, double-click reset, widths remembered per browser); the Consultation column is collapsible; below ~1180px the Copilot becomes an overlay. The case card follows the reference repo's outpatient layout: patient banner → tabs 病历记录 / 检验检查 / 诊断 / 处方 with yellow pending counts and blue "助手 n" counts → panel → bottom action bar "完诊 x/5". Built with React 19, TanStack Router, `@ui-sdk/react`, Tailwind CSS v4 (`@layer ui-sdk;` above Tailwind, `@ui-sdk/core/web.css` in `layer(components)`), and `ai-motion` for the halo. Visual tokens follow the reference repo's shadcn set: neutral primary, `info` blue reserved for Agent involvement, `success` / `warning` / `destructive` for normal / needs-review / allergy-critical; light and dark themes; 1 / 1.125 / 1.25 font scales; reduced-motion fallbacks.
- **Reference repo reuse (sibling full-HIS repo `clinmesh`)**: Golden Case data follows its Authored Case Pack schema (patient, visible history, hidden labs / ECG / echo with LOINC codings, reference ranges and stage, structured persona, compile-time persona-leak check), extended with allergies, vitals, **Physical Examination** findings, qualitative and imaging text results, and scripted **Report** amendments. Lab reference ranges, the formulary shape, and package-insert summaries are seeded from its catalogs, adding the non-penicillin antibiotics and urinalysis items it lacks. Reused data is copied in as a pinned snapshot recording source paths and reference commit `8d5b4069`; nothing is imported across repositories.
- **Reference prototype**: A single-file HTML prototype of the full workbench for Golden Case 1 is kept in main under the prototypes area (`copilot-workbench`). It encodes the agreed layout, interaction details, and state rules; it is not production code.

## Testing Decisions

A good test verifies **external observable behavior and clinical invariants** through real boundaries, never internal helpers or private state. Every vertical slice lands with tests at the two highest seams:

1. **Worker edge seam (backend integration and domain)**: Exercise the real Hono HTTP/WebSocket entry against real Durable Objects and SQLite (Cloudflare Workers Vitest pool / Miniflare), with test doubles **only** at the two external I/O boundaries:
   - a scripted **LLM provider** (the real `pi-durable` loop, checkpoint recovery, tool execution, context isolation between the two agents, run serialization, steer vs queue, stop semantics);
   - scripted **Bailian voice adapters** (`Transcriber` / `TTSProvider` driving the real `agents/voice` lifecycle: interim vs final sentences, WAV header repair, barge-in cancellation).
   - Invariants covered: **Case Truth** non-leakage before completion (including the Copilot's tool surface and context breakdown), single pending turn and failed-turn release, examination determinism, cancellation window, latest-version acknowledgement after amendment, one-primary diagnosis, prescription-after-diagnosis, class-level allergy red line and cephalosporin reason requirement, **Prescription** / **No Medication** exclusion, immutable note revisions and diagnosis staleness, abandonment not unlocking truth, atomic five-gate completion, replay creating an independent **Encounter**.
2. **Browser workbench seam (frontend)**: Render the real TanStack Router + `@ui-sdk/react` workbench in jsdom with Testing Library and a real `createAgent()` bridge, stubbing only HTTP/WebSocket transport and browser audio/media APIs.
   - Follows the `ui-sdk` agent-ready standard: every visible control has a unique accessible name; `agent.act()` populates **Drafts** across modules; doctor-edited or focused targets turn into **Suggestions** with working accept / dismiss / undo; halo state attributes activate and settle; `data-agent-confirm` refuses every formal commit until the doctor confirms.
   - Interaction behavior: both recording modes (toggle, hold-to-talk via pointer and Space, slide-up cancel, too-short guard, privacy pause), barge-in marking, debounce countdown with skip/now, automatic-analysis off with batched run, separator keyboard resizing and collapse, completion action bar and server refusal message.
- **Prior art**: this repo has no tests yet. The sibling reference repo's HTTP journey tests (whole-encounter flows through the real server) and its Testing Library workbench component tests are the models to follow; the prototype's scripted Golden Case 1 flow is the reference end-to-end scenario.

## Out of Scope

- Referral, emergency transfer, and admission workflows (disposition is recorded as **Clinical Note** plan text only).
- Multi-role hospital workflows: registration, triage nursing, cashier/billing, pharmacy inventory/dispensing, inpatient wards and beds, surgery and materials, record archiving, DRG/payer review.
- Real-clinic dual-human ambient listening and doctor voiceprint enrollment/verification (Phase 2; only the `speaker` field and attribution seam are reserved).
- Voice input to the **Clinical Copilot** (Phase 1 Copilot prompts are typed).
- User registration, login, and production RBAC (single demo practitioner with `practitionerId` on every audited write).
- Real LIS/PACS/DICOM viewers, pathology viewers, FHIR server ingestion, insurance interfaces.
- Penicillin red-line override, virtual clinical clock, and automated scoring of the **Case Debrief**.
- Calling, skipping, or transferring queued patients.
- Runtime LLM generation of new cases (Phase 1 ships four immutable curated **Golden Cases**).

## Further Notes

- Domain terminology is governed by `GLOSSARY.md`; architectural trade-offs are in ADR-0001, ADR-0002 and ADR-0003.
- Voice credentials (`BAILIAN_TOKEN`) follow the `voice` skill convention (local `.dev.vars` for Worker dev, mirroring the developer's environment file).
- The prototype scripts only Golden Case 1; its queue names for cases 2–4 are placeholders (case 2 uses the reference repo's NSTEMI patient in the real build).
- Prototype simulation shortcuts that are **not** product behavior: keyword-matched patient replies, second-scale report turnaround, and fixed context-token estimates.
