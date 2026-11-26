import { applyMigrations } from './sqlite-migrations'

// Append-only: each entry runs once per workspace, in order, recorded in schema_migration.
const MIGRATIONS: readonly string[] = [
  // Tables made before migrations were tracked held only case-pack data, which reconcile restores, so rebuild.
  `DROP TABLE IF EXISTS golden_case;
   CREATE TABLE golden_case (
     case_id TEXT PRIMARY KEY,
     queue_number INTEGER NOT NULL UNIQUE,
     patient_name TEXT NOT NULL,
     sex TEXT NOT NULL CHECK (sex IN ('male', 'female')),
     birth_date TEXT NOT NULL,
     chief_complaint TEXT NOT NULL,
     registered_at TEXT NOT NULL,
     visit_kind TEXT NOT NULL CHECK (visit_kind IN ('first', 'return'))
   );`,
  // Encounters keep the browser-visible chart they started with, so later case-pack edits don't rewrite them.
  // The partial unique index makes "one active Encounter per workspace" a storage invariant too.
  `CREATE TABLE encounter (
     encounter_id TEXT PRIMARY KEY,
     case_id TEXT NOT NULL,
     case_version TEXT NOT NULL,
     persona_version TEXT NOT NULL,
     practitioner_id TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('active', 'abandoned', 'completed')),
     started_at TEXT NOT NULL,
     ended_at TEXT,
     visible_chart TEXT NOT NULL
   );
   CREATE UNIQUE INDEX encounter_single_active ON encounter (status) WHERE status = 'active';
   CREATE TABLE audit_event (
     audit_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
     encounter_id TEXT NOT NULL REFERENCES encounter (encounter_id),
     event_type TEXT NOT NULL,
     practitioner_id TEXT NOT NULL,
     occurred_at TEXT NOT NULL
   );
   CREATE INDEX audit_event_by_encounter ON audit_event (encounter_id, audit_event_id);`,
  // The primary key makes "each body system once per Encounter" a storage invariant. The finding is kept as revealed.
  `CREATE TABLE physical_examination (
     encounter_id TEXT NOT NULL REFERENCES encounter (encounter_id),
     body_system TEXT NOT NULL CHECK (body_system IN ('vitals', 'general', 'pharynx', 'lungs', 'heart', 'abdomen')),
     finding TEXT NOT NULL,
     vitals TEXT,
     practitioner_id TEXT NOT NULL,
     examined_at TEXT NOT NULL,
     PRIMARY KEY (encounter_id, body_system)
   );`,
  // Investigations keep the planned time of each category stage; the last one releases Report version 1.
  // Report versions are immutable rows; a Report Acknowledgement belongs to exactly one version.
  // Audit events gain the subject they acted on (catalog item, Report, body system); earlier rows keep NULL.
  `ALTER TABLE audit_event ADD COLUMN subject TEXT;
   CREATE TABLE investigation (
     investigation_id TEXT PRIMARY KEY,
     encounter_id TEXT NOT NULL REFERENCES encounter (encounter_id),
     catalog_item_id TEXT NOT NULL,
     practitioner_id TEXT NOT NULL,
     issued_at TEXT NOT NULL,
     stage_times TEXT NOT NULL
   );
   CREATE INDEX investigation_by_encounter ON investigation (encounter_id);
   CREATE TABLE report (
     report_id TEXT PRIMARY KEY,
     investigation_id TEXT NOT NULL REFERENCES investigation (investigation_id),
     version INTEGER NOT NULL,
     released_at TEXT NOT NULL,
     content TEXT NOT NULL,
     UNIQUE (investigation_id, version)
   );
   CREATE TABLE report_acknowledgement (
     report_id TEXT PRIMARY KEY REFERENCES report (report_id),
     practitioner_id TEXT NOT NULL,
     acknowledged_at TEXT NOT NULL
   );`,
  // The Consultation: doctor utterances and Simulated Patient replies in strict order. A patient turn is one
  // reply attempt to a doctor turn; a failed attempt stays and a retry appends the next one. The partial unique
  // index makes "one pending patient turn per Encounter" a storage invariant too.
  `CREATE TABLE consultation_turn (
     turn_id TEXT PRIMARY KEY,
     encounter_id TEXT NOT NULL REFERENCES encounter (encounter_id),
     seq INTEGER NOT NULL,
     speaker TEXT NOT NULL CHECK (speaker IN ('doctor', 'patient')),
     source TEXT NOT NULL,
     attribution TEXT NOT NULL,
     text TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('final', 'pending', 'failed')),
     reply_to TEXT REFERENCES consultation_turn (turn_id),
     attempt INTEGER NOT NULL DEFAULT 1,
     client_turn_id TEXT,
     practitioner_id TEXT,
     created_at TEXT NOT NULL,
     settled_at TEXT,
     deadline_at TEXT,
     failure_reason TEXT,
     -- Who settled a patient turn: the Simulated Patient's own outcome, or the workspace failing it (expiry,
     -- abandonment, patient unreachable). A redelivered patient settlement is accepted again only for the former.
     settled_by TEXT CHECK (settled_by IN ('simulated-patient', 'workspace')),
     UNIQUE (encounter_id, seq),
     UNIQUE (encounter_id, client_turn_id)
   );
   CREATE UNIQUE INDEX consultation_single_pending ON consultation_turn (encounter_id) WHERE status = 'pending';`,
  // A cancellation is an immutable fact about one Investigation, so it cannot happen twice.
  `CREATE TABLE investigation_cancellation (
     investigation_id TEXT PRIMARY KEY REFERENCES investigation (investigation_id),
     practitioner_id TEXT NOT NULL,
     cancelled_at TEXT NOT NULL
   );`,
  // The Clinical Note: one Draft row per section once written, with who last wrote it (the doctor, or later the
  // Clinical Copilot), and signed revisions as immutable rows. Each revision takes the next number of the
  // Encounter's clinical revision sequence, which Diagnosis revisions share, so the two can be ordered.
  `ALTER TABLE encounter ADD COLUMN revision_seq INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE clinical_note_section (
     encounter_id TEXT NOT NULL REFERENCES encounter (encounter_id),
     section TEXT NOT NULL
       CHECK (section IN ('chief-complaint', 'present-illness', 'past-history', 'findings', 'assessment', 'plan')),
     content TEXT NOT NULL,
     last_edited_by TEXT NOT NULL CHECK (last_edited_by IN ('doctor', 'assistant')),
     updated_at TEXT NOT NULL,
     PRIMARY KEY (encounter_id, section)
   );
   CREATE TABLE clinical_note_revision (
     revision_id TEXT PRIMARY KEY,
     encounter_id TEXT NOT NULL REFERENCES encounter (encounter_id),
     version INTEGER NOT NULL,
     seq INTEGER NOT NULL,
     content TEXT NOT NULL,
     practitioner_id TEXT NOT NULL,
     signed_at TEXT NOT NULL,
     UNIQUE (encounter_id, version),
     UNIQUE (encounter_id, seq)
   );
   CREATE TRIGGER clinical_note_revision_no_update BEFORE UPDATE ON clinical_note_revision
   BEGIN SELECT RAISE(ABORT, 'signed Clinical Note revisions are immutable'); END;
   CREATE TRIGGER clinical_note_revision_no_delete BEFORE DELETE ON clinical_note_revision
   BEGIN SELECT RAISE(ABORT, 'signed Clinical Note revisions are immutable'); END;`,
  // The Diagnosis: one Draft row per Encounter holding the candidate entries, and confirmed revisions as
  // immutable rows that take the next number of the Encounter's clinical revision sequence, shared with
  // signed Clinical Note revisions, so the two can be ordered.
  `CREATE TABLE diagnosis_draft (
     encounter_id TEXT PRIMARY KEY REFERENCES encounter (encounter_id),
     entries TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE diagnosis_revision (
     revision_id TEXT PRIMARY KEY,
     encounter_id TEXT NOT NULL REFERENCES encounter (encounter_id),
     version INTEGER NOT NULL,
     seq INTEGER NOT NULL,
     entries TEXT NOT NULL,
     practitioner_id TEXT NOT NULL,
     confirmed_at TEXT NOT NULL,
     UNIQUE (encounter_id, version),
     UNIQUE (encounter_id, seq)
   );
   CREATE TRIGGER diagnosis_revision_no_update BEFORE UPDATE ON diagnosis_revision
   BEGIN SELECT RAISE(ABORT, 'confirmed Diagnosis revisions are immutable'); END;
   CREATE TRIGGER diagnosis_revision_no_delete BEFORE DELETE ON diagnosis_revision
   BEGIN SELECT RAISE(ABORT, 'confirmed Diagnosis revisions are immutable'); END;`,
  // The Prescription: issued lines as immutable rows (there is no cancellation), each carrying the total
  // quantity the server computed, and a No Medication conclusion as one row per Encounter. The two are
  // mutually exclusive; the repositories enforce that inside the caller's transaction.
  `CREATE TABLE prescription_line (
     line_id TEXT PRIMARY KEY,
     encounter_id TEXT NOT NULL REFERENCES encounter (encounter_id),
     drug_id TEXT NOT NULL,
     drug_name TEXT NOT NULL,
     spec TEXT NOT NULL,
     dose REAL NOT NULL,
     dose_unit TEXT NOT NULL,
     route TEXT NOT NULL,
     frequency TEXT NOT NULL,
     days INTEGER NOT NULL,
     total_quantity TEXT NOT NULL,
     drug_class TEXT NOT NULL,
     drug_class_name TEXT NOT NULL,
     override_reason TEXT,
     override_note TEXT,
     practitioner_id TEXT NOT NULL,
     issued_at TEXT NOT NULL
   );
   CREATE INDEX prescription_line_by_encounter ON prescription_line (encounter_id);
   CREATE TRIGGER prescription_line_no_update BEFORE UPDATE ON prescription_line
   BEGIN SELECT RAISE(ABORT, 'issued prescription lines are immutable'); END;
   CREATE TRIGGER prescription_line_no_delete BEFORE DELETE ON prescription_line
   BEGIN SELECT RAISE(ABORT, 'issued prescription lines are immutable'); END;
   CREATE TABLE no_medication (
     encounter_id TEXT PRIMARY KEY REFERENCES encounter (encounter_id),
     practitioner_id TEXT NOT NULL,
     recorded_at TEXT NOT NULL
   );`,
  // Spoken doctor turns keep how they were recognized: the recognizer, how long the doctor spoke and the
  // recognizer's confidence (NULL when it reports none). Typed and patient turns leave all three NULL.
  `ALTER TABLE consultation_turn ADD COLUMN voice_recognizer TEXT CHECK (voice_recognizer IN ('paraformer-realtime-v2', 'web-speech'));
   ALTER TABLE consultation_turn ADD COLUMN voice_duration_ms INTEGER;
   ALTER TABLE consultation_turn ADD COLUMN voice_confidence REAL;`,
  `CREATE TABLE encounter_draft (
     encounter_id TEXT NOT NULL REFERENCES encounter (encounter_id),
     kind TEXT NOT NULL CHECK (kind IN ('investigations', 'prescriptions')),
     entries TEXT NOT NULL,
     PRIMARY KEY (encounter_id, kind)
   );
   CREATE TABLE case_debrief_reference (
     encounter_id TEXT PRIMARY KEY REFERENCES encounter (encounter_id),
     reference TEXT NOT NULL
   );`,
  `CREATE TABLE copilot_draft_proposal (
     encounter_id TEXT NOT NULL REFERENCES encounter (encounter_id),
     id TEXT NOT NULL,
     run_id TEXT,
     action_json TEXT NOT NULL,
     label TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'accepted', 'dismissed')),
     undo_json TEXT,
     assistant_attribution INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (encounter_id, id)
   );
   CREATE INDEX copilot_draft_proposal_by_run ON copilot_draft_proposal (encounter_id, run_id, status);
   CREATE TABLE doctor_draft_touch (
     encounter_id TEXT NOT NULL REFERENCES encounter (encounter_id),
     module TEXT NOT NULL,
     PRIMARY KEY (encounter_id, module)
   );
   INSERT INTO doctor_draft_touch (encounter_id, module)
     SELECT encounter_id, kind FROM encounter_draft WHERE json_array_length(entries) > 0;
   INSERT INTO doctor_draft_touch (encounter_id, module)
     SELECT encounter_id, 'diagnosis' FROM diagnosis_draft WHERE json_array_length(entries) > 0;
   CREATE TABLE copilot_draft_stop (
     encounter_id TEXT NOT NULL REFERENCES encounter (encounter_id),
     run_id TEXT NOT NULL,
     PRIMARY KEY (encounter_id, run_id)
   );`,
  // Connected Clinic S1: actors, accounts, hashed bearer sessions, patient/staff profiles, care relationships,
  // appointment slots, patient-visible releases, clinic audit log, and optional encounter patient/appointment links.
  `CREATE TABLE clinic_department (
     department_id TEXT PRIMARY KEY,
     name TEXT NOT NULL
   );
   CREATE TABLE actor (
     actor_id TEXT PRIMARY KEY,
     clinic_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'system')),
     role TEXT NOT NULL CHECK (role IN ('patient', 'doctor', 'nurse', 'admin', 'agent')),
     display_name TEXT NOT NULL,
     im_uid TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL CHECK (status IN ('active', 'disabled'))
   );
   CREATE TABLE staff_profile (
     staff_id TEXT PRIMARY KEY,
     actor_id TEXT NOT NULL UNIQUE REFERENCES actor (actor_id),
     role TEXT NOT NULL CHECK (role IN ('doctor', 'nurse', 'admin')),
     title TEXT NOT NULL,
     department_id TEXT NOT NULL REFERENCES clinic_department (department_id),
     username TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL
   );
   CREATE TABLE patient_profile (
     patient_id TEXT PRIMARY KEY,
     actor_id TEXT NOT NULL UNIQUE REFERENCES actor (actor_id),
     display_name TEXT NOT NULL,
     sex TEXT NOT NULL CHECK (sex IN ('male', 'female')),
     birth_date TEXT NOT NULL,
     outpatient_number TEXT NOT NULL UNIQUE,
     primary_doctor_id TEXT REFERENCES staff_profile (staff_id),
     department_id TEXT NOT NULL REFERENCES clinic_department (department_id),
     allergies_json TEXT NOT NULL,
     chronic_conditions_json TEXT NOT NULL,
     invite_code_hash TEXT UNIQUE,
     invite_code_expires_at TEXT,
     bound_at TEXT
   );
   CREATE TABLE account (
     account_id TEXT PRIMARY KEY,
     provider TEXT NOT NULL CHECK (provider IN ('wechat', 'staff')),
     provider_subject TEXT NOT NULL,
     actor_id TEXT NOT NULL REFERENCES actor (actor_id),
     status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
     created_at TEXT NOT NULL,
     UNIQUE (provider, provider_subject)
   );
   CREATE TABLE auth_session (
     session_id TEXT PRIMARY KEY,
     token_hash TEXT NOT NULL UNIQUE,
     account_id TEXT NOT NULL REFERENCES account (account_id),
     actor_id TEXT NOT NULL REFERENCES actor (actor_id),
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     revoked_at TEXT
   );
   CREATE INDEX auth_session_by_actor ON auth_session (actor_id);
   CREATE TABLE care_relationship (
     patient_id TEXT NOT NULL REFERENCES patient_profile (patient_id),
     staff_id TEXT NOT NULL REFERENCES staff_profile (staff_id),
     relation_kind TEXT NOT NULL CHECK (relation_kind IN ('primary', 'department', 'followup')),
     created_at TEXT NOT NULL,
     PRIMARY KEY (patient_id, staff_id, relation_kind)
   );
   CREATE TABLE appointment_slot (
     slot_id TEXT PRIMARY KEY,
     doctor_id TEXT NOT NULL REFERENCES staff_profile (staff_id),
     department_id TEXT NOT NULL REFERENCES clinic_department (department_id),
     starts_at TEXT NOT NULL,
     ends_at TEXT NOT NULL,
     capacity INTEGER NOT NULL CHECK (capacity > 0),
     status TEXT NOT NULL CHECK (status IN ('open', 'closed'))
   );
   CREATE TABLE patient_release (
     release_id TEXT PRIMARY KEY,
     patient_id TEXT NOT NULL REFERENCES patient_profile (patient_id),
     encounter_id TEXT,
     resource_type TEXT NOT NULL CHECK (resource_type IN ('clinical_note', 'report', 'prescription')),
     resource_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     title TEXT NOT NULL,
     summary TEXT NOT NULL,
     payload_json TEXT NOT NULL,
     published_by TEXT NOT NULL REFERENCES actor (actor_id),
     published_at TEXT NOT NULL,
     retracted_at TEXT,
     UNIQUE (resource_type, resource_id, version)
   );
   CREATE INDEX patient_release_by_patient ON patient_release (patient_id, resource_type, published_at);
   CREATE TABLE clinic_audit_event (
     audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
     actor_id TEXT NOT NULL,
     actor_role TEXT NOT NULL,
     action TEXT NOT NULL,
     resource_type TEXT NOT NULL,
     resource_id TEXT NOT NULL,
     request_id TEXT,
     run_id TEXT,
     outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'error')),
     occurred_at TEXT NOT NULL
   );
   ALTER TABLE encounter ADD COLUMN patient_id TEXT;
   ALTER TABLE encounter ADD COLUMN appointment_id TEXT;
   CREATE UNIQUE INDEX encounter_by_appointment ON encounter (appointment_id) WHERE appointment_id IS NOT NULL;`,
  // Connected Clinic S2/S4/S5/S7: appointments, conversations, membership, reliable send_command/outbox,
  // local attachment storage, and follow-up plans/tasks/responses/summaries.
  `CREATE TABLE appointment (
     appointment_id TEXT PRIMARY KEY,
     patient_id TEXT NOT NULL REFERENCES patient_profile (patient_id),
     slot_id TEXT NOT NULL REFERENCES appointment_slot (slot_id),
     doctor_id TEXT NOT NULL REFERENCES staff_profile (staff_id),
     department_id TEXT NOT NULL REFERENCES clinic_department (department_id),
     status TEXT NOT NULL CHECK (status IN ('booked', 'checked_in', 'in_encounter', 'completed', 'cancelled')),
     client_request_id TEXT NOT NULL,
     encounter_id TEXT,
     chief_complaint TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     cancelled_at TEXT,
     UNIQUE (patient_id, client_request_id)
   );
   CREATE UNIQUE INDEX appointment_active_patient_slot
     ON appointment (patient_id, slot_id)
     WHERE status IN ('booked', 'checked_in', 'in_encounter');
   CREATE INDEX appointment_by_slot ON appointment (slot_id, status);
   CREATE INDEX appointment_by_doctor ON appointment (doctor_id, created_at);

   CREATE TABLE conversation (
     conversation_id TEXT PRIMARY KEY,
     type TEXT NOT NULL CHECK (type IN ('patient_assistant', 'patient_doctor', 'staff_direct', 'staff_group', 'followup_group')),
     title TEXT NOT NULL,
     im_channel_id TEXT NOT NULL UNIQUE,
     im_channel_type INTEGER NOT NULL DEFAULT 2,
     direct_key TEXT UNIQUE,
     patient_id TEXT,
     encounter_id TEXT,
     followup_plan_id TEXT,
     department_id TEXT,
     status TEXT NOT NULL CHECK (status IN ('provisioning', 'active', 'read_only', 'archived')),
     membership_version INTEGER NOT NULL DEFAULT 1,
     created_by TEXT NOT NULL REFERENCES actor (actor_id),
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE conversation_member (
     conversation_id TEXT NOT NULL REFERENCES conversation (conversation_id),
     actor_id TEXT NOT NULL REFERENCES actor (actor_id),
     role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'agent')),
     status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'removed')),
     joined_at TEXT NOT NULL,
     removed_at TEXT,
     last_read_seq INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (conversation_id, actor_id)
   );
   CREATE INDEX conversation_member_by_actor ON conversation_member (actor_id, status);

   CREATE TABLE send_command (
     command_id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL REFERENCES conversation (conversation_id),
     client_message_id TEXT NOT NULL,
     actor_id TEXT NOT NULL REFERENCES actor (actor_id),
     payload_json TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
     attempts INTEGER NOT NULL DEFAULT 0,
     external_message_id TEXT,
     sequence INTEGER,
     last_error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (conversation_id, client_message_id)
   );
   CREATE TABLE im_message_mirror (
     message_id TEXT PRIMARY KEY,
     client_message_id TEXT NOT NULL,
     conversation_id TEXT NOT NULL REFERENCES conversation (conversation_id),
     sequence INTEGER NOT NULL,
     sender_actor_id TEXT NOT NULL REFERENCES actor (actor_id),
     sender_kind TEXT NOT NULL CHECK (sender_kind IN ('human', 'agent', 'system')),
     payload_json TEXT NOT NULL,
     agent_run_id TEXT,
     created_at TEXT NOT NULL,
     UNIQUE (conversation_id, sequence),
     UNIQUE (conversation_id, client_message_id)
   );
   CREATE TABLE im_user_token (
     actor_id TEXT PRIMARY KEY REFERENCES actor (actor_id),
     im_uid TEXT NOT NULL,
     token TEXT NOT NULL,
     version INTEGER NOT NULL DEFAULT 1,
     updated_at TEXT NOT NULL
   );

   CREATE TABLE attachment (
     attachment_id TEXT PRIMARY KEY,
     owner_actor_id TEXT NOT NULL REFERENCES actor (actor_id),
     conversation_id TEXT NOT NULL REFERENCES conversation (conversation_id),
     kind TEXT NOT NULL CHECK (kind IN ('audio', 'image')),
     mime TEXT NOT NULL,
     size INTEGER NOT NULL,
     duration_ms INTEGER,
     status TEXT NOT NULL CHECK (status IN ('pending', 'uploaded', 'ready', 'rejected')),
     hash TEXT,
     transcript_status TEXT NOT NULL DEFAULT 'none' CHECK (transcript_status IN ('none', 'pending', 'ready', 'failed', 'unavailable')),
     transcript_text TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE attachment_blob (
     attachment_id TEXT PRIMARY KEY REFERENCES attachment (attachment_id),
     data_base64 TEXT NOT NULL
   );

   CREATE TABLE followup_plan (
     plan_id TEXT PRIMARY KEY,
     patient_id TEXT NOT NULL REFERENCES patient_profile (patient_id),
     encounter_id TEXT,
     owner_staff_id TEXT NOT NULL REFERENCES staff_profile (staff_id),
     title TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
     conversation_id TEXT,
     start_at TEXT NOT NULL,
     end_at TEXT,
     created_at TEXT NOT NULL,
     closed_at TEXT
   );
   CREATE TABLE followup_task (
     task_id TEXT PRIMARY KEY,
     plan_id TEXT NOT NULL REFERENCES followup_plan (plan_id),
     kind TEXT NOT NULL,
     title TEXT NOT NULL,
     due_at TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending', 'submitted', 'reviewed')),
     questionnaire_version INTEGER NOT NULL DEFAULT 1,
     schema_json TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE followup_response (
     response_id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL REFERENCES followup_task (task_id),
     plan_id TEXT NOT NULL REFERENCES followup_plan (plan_id),
     patient_id TEXT NOT NULL REFERENCES patient_profile (patient_id),
     payload_json TEXT NOT NULL,
     idempotency_key TEXT NOT NULL,
     submitted_at TEXT NOT NULL,
     UNIQUE (task_id, patient_id),
     UNIQUE (patient_id, idempotency_key)
   );
   CREATE TABLE followup_summary (
     summary_id TEXT PRIMARY KEY,
     plan_id TEXT NOT NULL REFERENCES followup_plan (plan_id),
     version INTEGER NOT NULL,
     source_response_ids_json TEXT NOT NULL,
     draft_text TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'rejected')),
     created_by TEXT NOT NULL REFERENCES actor (actor_id),
     reviewed_by TEXT REFERENCES actor (actor_id),
     reviewed_at TEXT,
     review_note TEXT,
     created_at TEXT NOT NULL,
     UNIQUE (plan_id, version)
   );
   CREATE TABLE review_task (
     review_task_id TEXT PRIMARY KEY,
     plan_id TEXT NOT NULL REFERENCES followup_plan (plan_id),
     source_ref TEXT NOT NULL,
     reason TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
     created_by TEXT NOT NULL REFERENCES actor (actor_id),
     created_at TEXT NOT NULL,
     UNIQUE (plan_id, source_ref)
   );
   CREATE TABLE agent_run_index (
     run_id TEXT PRIMARY KEY,
     agent_kind TEXT NOT NULL CHECK (agent_kind IN ('patient_service', 'followup')),
     do_name TEXT NOT NULL,
     conversation_id TEXT NOT NULL REFERENCES conversation (conversation_id),
     trigger_actor_id TEXT NOT NULL,
     created_at TEXT NOT NULL
   );`,
]

export function migrateWorkspaceSchema(sql: SqlStorage): void {
  applyMigrations(sql, 'schema_migration', MIGRATIONS)
}
