"""FHIR-inspired records passed into the rule engine. Decisions never live here."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True)
class Observation:
    id: str
    patient_id: str
    code: str
    value: float | None
    unit: str
    effective_date: date
    source: str
    document_patient_id: str | None = None


@dataclass(frozen=True)
class DiagnosticReport:
    id: str
    patient_id: str
    report_type: str
    report_date: date | None
    conclusion_text: str
    source: str
    document_patient_id: str | None = None
    evidence: str | None = None


@dataclass(frozen=True)
class AnesthesiaClearance:
    id: str
    patient_id: str
    status: str
    clearance_date: date | None
    asa_class: str | None
    conditions: tuple[str, ...]
    anesthetist: str | None
    source: str


@dataclass(frozen=True)
class Medication:
    id: str
    patient_id: str
    name: str
    drug_class: str
    status: str
    paused_since: date | None
    source: str


@dataclass(frozen=True)
class Finding:
    category: str
    severity: str
    item: str
    message_de: str
    message_en: str
    source_ref: str
    role: str
