"""SQLite storage. Parameterized SQL only."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS patients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    birth_date TEXT NOT NULL,
    sex TEXT NOT NULL,
    ward TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS procedures (
    id TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL,
    procedure_type TEXT NOT NULL,
    planned_date TEXT NOT NULL,
    planned_time TEXT NOT NULL,
    operator TEXT NOT NULL,
    status TEXT NOT NULL,
    readiness TEXT,
    confirmed_by TEXT,
    confirmed_at TEXT,
    confirmed_user_id TEXT
);

CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL,
    code TEXT NOT NULL,
    value REAL,
    unit TEXT NOT NULL,
    effective_date TEXT NOT NULL,
    source TEXT NOT NULL,
    document_patient_id TEXT
);

CREATE TABLE IF NOT EXISTS diagnostic_reports (
    id TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL,
    type TEXT NOT NULL,
    report_date TEXT,
    conclusion_text TEXT NOT NULL,
    extracted_findings TEXT,
    source_file TEXT NOT NULL,
    document_patient_id TEXT,
    evidence TEXT
);

CREATE TABLE IF NOT EXISTS anesthesia_clearances (
    id TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL,
    status TEXT NOT NULL,
    clearance_date TEXT,
    asa_class TEXT,
    conditions_json TEXT NOT NULL,
    anesthetist TEXT,
    source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS medications (
    id TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL,
    name TEXT NOT NULL,
    drug_class TEXT NOT NULL,
    status TEXT NOT NULL,
    paused_since TEXT,
    source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS findings (
    id TEXT PRIMARY KEY,
    procedure_id TEXT NOT NULL,
    patient_id TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    item TEXT NOT NULL,
    message_de TEXT NOT NULL,
    message_en TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    role TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    procedure_id TEXT NOT NULL,
    patient_id TEXT NOT NULL,
    finding_id TEXT,
    item TEXT NOT NULL,
    category TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    text_de TEXT NOT NULL,
    text_en TEXT NOT NULL,
    assigned_role TEXT NOT NULL,
    status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    actor_id TEXT,
    actor_name TEXT,
    entity_type TEXT,
    entity_id TEXT,
    detail_json TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_procedures_date ON procedures(planned_date);
CREATE INDEX IF NOT EXISTS idx_observations_patient ON observations(patient_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
"""


_RESOLVED_PATH: Path | None = None


def resolve_db_path() -> Path:
    """Resolve once per process so every request uses the same SQLite file."""
    global _RESOLVED_PATH
    if _RESOLVED_PATH is not None:
        return _RESOLVED_PATH

    override = os.environ.get("PREOP_DB_PATH")
    if override:
        target = Path(override)
        target.parent.mkdir(parents=True, exist_ok=True)
        _RESOLVED_PATH = target
        return target

    preferred = Path("/data/preop-ready.sqlite")
    try:
        preferred.parent.mkdir(parents=True, exist_ok=True)
        probe = preferred.parent / ".write-probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        _RESOLVED_PATH = preferred
        return preferred
    except OSError:
        fallback = Path(__file__).resolve().parent.parent / "data"
        fallback.mkdir(parents=True, exist_ok=True)
        _RESOLVED_PATH = fallback / "preop-ready.sqlite"
        return _RESOLVED_PATH


def connect(path: str | Path | None = None) -> sqlite3.Connection:
    target = Path(path) if path else resolve_db_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    # check_same_thread=False: FastAPI may create the dependency connection
    # on a different worker thread than the sync route handler.
    conn = sqlite3.connect(str(target), timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
