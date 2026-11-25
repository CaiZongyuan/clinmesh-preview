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
]

export function migrateWorkspaceSchema(sql: SqlStorage): void {
  applyMigrations(sql, 'schema_migration', MIGRATIONS)
}
