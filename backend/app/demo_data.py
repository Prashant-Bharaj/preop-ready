"""Synthetic cohort. Dates are relative to the day the seed runs."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

from app.domain import (
    AnesthesiaClearance,
    DiagnosticReport,
    Medication,
    Observation,
)

NORMAL_LABS: dict[str, tuple[float, str]] = {
    "hb": (13.4, "g/dL"),
    "platelets": (240, "10^9/L"),
    "inr": (1.0, "ratio"),
    "aptt": (31, "s"),
    "creatinine": (80, "µmol/L"),
    "egfr": (78, "mL/min/1.73m2"),
    "potassium": (4.1, "mmol/L"),
    "sodium": (139, "mmol/L"),
    "tsh": (1.6, "mU/L"),
    "crp": (1.2, "mg/L"),
    "bnp": (48, "pmol/L"),
}


@dataclass(frozen=True)
class DemoPatient:
    id: str
    name: str
    birth_date: date
    sex: str
    ward: str


@dataclass(frozen=True)
class DemoProcedure:
    id: str
    patient_id: str
    procedure_type: str
    planned_date: date
    planned_time: str
    operator: str
    status: str = "planned"


@dataclass
class DemoWorld:
    patients: list[DemoPatient]
    procedures: list[DemoProcedure]
    observations: list[Observation]
    reports: list[DiagnosticReport]
    clearances: list[AnesthesiaClearance]
    medications: list[Medication]


def build_demo_world(today: date | None = None) -> DemoWorld:
    anchor = today or date.today()
    planned = anchor + timedelta(days=1)
    horizon = anchor + timedelta(days=14)
    patients = [
        DemoPatient("pat-a", "Testperson A", date(1948, 3, 12), "female", "Station Kardiologie 1"),
        DemoPatient("pat-b", "Testperson B", date(1952, 7, 1), "male", "Station Kardiologie 1"),
        DemoPatient("pat-c", "Testperson C", date(1946, 11, 20), "female", "Station Kardiologie 2"),
        DemoPatient("pat-d", "Testperson D", date(1955, 1, 9), "male", "Station Kardiologie 2"),
        DemoPatient("pat-e", "Testperson E", date(1949, 5, 18), "male", "Station Kardiologie 1"),
        DemoPatient("pat-f", "Testperson F", date(1951, 9, 30), "female", "Station Kardiologie 2"),
        DemoPatient("pat-g", "Testperson G", date(1950, 4, 22), "female", "Station Kardiologie 1"),
        DemoPatient("pat-h", "Testperson H", date(1947, 8, 14), "male", "Station Kardiologie 2"),
        DemoPatient("pat-i", "Testperson I", date(1953, 12, 3), "female", "Station Kardiologie 1"),
        DemoPatient("pat-j", "Testperson J", date(1945, 6, 27), "male", "Station Kardiologie 2"),
    ]
    procedures = [
        DemoProcedure("proc-a", "pat-a", "TAVI", planned, "07:30", "Dr. Test Operateur"),
        DemoProcedure("proc-b", "pat-b", "M-TEER", planned, "08:15", "Dr. Test Operateur"),
        DemoProcedure("proc-c", "pat-c", "TAVI", planned, "09:00", "Dr. Test Operateur"),
        DemoProcedure("proc-d", "pat-d", "M-TEER", planned, "10:30", "Dr. Test Operateur"),
        DemoProcedure("proc-e", "pat-e", "TAVI", planned, "11:45", "Dr. Test Operateur"),
        DemoProcedure("proc-f", "pat-f", "TAVI", planned, "13:00", "Dr. Test Operateur"),
        DemoProcedure("proc-g", "pat-g", "TAVI", anchor, "08:00", "Dr. Test Operateur"),
        DemoProcedure("proc-h", "pat-h", "M-TEER", anchor, "11:30", "Dr. Test Operateur"),
        DemoProcedure("proc-i", "pat-i", "TAVI", horizon, "09:15", "Dr. Test Operateur"),
        DemoProcedure("proc-j", "pat-j", "M-TEER", horizon, "14:00", "Dr. Test Operateur"),
    ]

    observations: list[Observation] = []
    observations += _labs("pat-a", planned + timedelta(days=-2))
    observations += _labs("pat-b", planned + timedelta(days=-10))
    observations += _labs(
        "pat-c",
        planned + timedelta(days=-1),
        overrides={"potassium": (2.4, "mmol/L")},
    )
    observations += _labs("pat-d", planned + timedelta(days=-1))
    observations += _labs(
        "pat-e",
        planned + timedelta(days=-1),
        overrides={"creatinine": (1.1, "mg/dL")},
    )
    observations += _labs("pat-f", planned + timedelta(days=-1))
    observations += _labs("pat-g", anchor + timedelta(days=-1))
    observations += _labs(
        "pat-h",
        anchor + timedelta(days=-2),
        overrides={"hb": (9.8, "g/dL")},
    )
    observations += _labs("pat-i", horizon + timedelta(days=-5))
    observations += _labs(
        "pat-j",
        horizon + timedelta(days=-2),
        overrides={"potassium": (3.1, "mmol/L")},
    )

    echo_a = "Gute Schallbedingungen. LVEF 60 %. Aortenklappe hochgradig stenosiert."
    echo_tee = (
        "Transösophageale Echokardiographie (TEE). Schwere Mitralklappeninsuffizienz. "
        "LVEF 55 %. Kein Thrombus im linken Vorhof."
    )
    xray = "Keine Infiltrate. Herzgröße normal."
    ecg = "Sinusrhythmus, keine Ischämiezeichen."
    agreement = (
        "Einverständniserklärung zum geplanten Eingriff. "
        "Patientenunterschrift liegt vor. Aufklärung ist erfolgt."
    )
    duplex_pre = (
        "Duplexsonographie der Leiste (transfemoraler Zugang): "
        "Gefäße unauffällig, Zugang möglich."
    )
    duplex_post = (
        "Duplexsonographie der Leiste postinterventionell: "
        "kein Aneurysma, keine Blutung."
    )
    gastroscopy = "Gastroskopie einen Tag nach dem Eingriff: unauffälliger Befund."

    reports = [
        _report("pat-a", "ECHO", planned + timedelta(days=-20), echo_a),
        _report("pat-a", "CHEST_XRAY", planned + timedelta(days=-5), xray),
        _report("pat-a", "ECG", planned + timedelta(days=-1), ecg),
        _report("pat-a", "AGREEMENT", planned + timedelta(days=-2), agreement),
        _report("pat-a", "DUPLEX_GROIN_PRE", planned + timedelta(days=-1), duplex_pre),
        _report("pat-a", "DUPLEX_GROIN_POST", planned + timedelta(days=1), duplex_post),
        _report("pat-a", "GASTROSCOPY", planned + timedelta(days=1), gastroscopy),
        _report(
            "pat-a",
            "ECHO_6W",
            planned + timedelta(days=42),
            "Echo-Kontrolle 6 Wochen: Klappenfunktion stabil, LVEF 60 %.",
        ),
        _report(
            "pat-a",
            "ECHO_6M",
            planned + timedelta(days=183),
            "Echo-Kontrolle 6 Monate: kein Hinweis auf Klappendysfunktion.",
        ),
        _report("pat-b", "ECHO", planned + timedelta(days=-10), echo_tee),
        _report("pat-b", "CHEST_XRAY", planned + timedelta(days=-4), xray),
        _report("pat-b", "ECG", planned + timedelta(days=-2), ecg),
        _report("pat-b", "AGREEMENT", planned + timedelta(days=-2), agreement),
        _report("pat-b", "DUPLEX_GROIN_PRE", planned + timedelta(days=-1), duplex_pre),
        _report("pat-c", "CHEST_XRAY", planned + timedelta(days=-3), xray),
        _report("pat-c", "ECG", planned + timedelta(days=-1), ecg),
        _report("pat-d", "ECHO", planned + timedelta(days=-6), echo_tee),
        _report("pat-d", "CHEST_XRAY", planned + timedelta(days=-2), xray),
        _report("pat-d", "ECG", planned + timedelta(days=-1), ecg),
        _report("pat-d", "AGREEMENT", planned + timedelta(days=-2), agreement),
        _report("pat-d", "DUPLEX_GROIN_PRE", planned + timedelta(days=-1), duplex_pre),
        _report("pat-e", "ECHO", planned + timedelta(days=-15), echo_a),
        _report("pat-e", "CHEST_XRAY", planned + timedelta(days=-4), xray),
        _report("pat-e", "ECG", planned + timedelta(days=-1), ecg),
        _report("pat-e", "AGREEMENT", planned + timedelta(days=-2), agreement),
        _report("pat-e", "DUPLEX_GROIN_PRE", planned + timedelta(days=-1), duplex_pre),
        _report("pat-f", "ECHO", planned + timedelta(days=-12), echo_a),
        _report("pat-f", "CHEST_XRAY", planned + timedelta(days=1), xray),
        _report("pat-f", "ECG", planned + timedelta(days=-1), ecg),
        _report("pat-f", "AGREEMENT", planned + timedelta(days=-2), agreement),
        _report("pat-f", "DUPLEX_GROIN_PRE", planned + timedelta(days=-1), duplex_pre),
        # Heute
        _report("pat-g", "ECHO", anchor + timedelta(days=-18), echo_a),
        _report("pat-g", "CHEST_XRAY", anchor + timedelta(days=-4), xray),
        _report("pat-g", "ECG", anchor, ecg),
        _report("pat-g", "AGREEMENT", anchor + timedelta(days=-1), agreement),
        _report("pat-g", "DUPLEX_GROIN_PRE", anchor, duplex_pre),
        _report("pat-h", "ECHO", anchor + timedelta(days=-8), echo_tee),
        _report("pat-h", "ECG", anchor + timedelta(days=-1), ecg),
        # T-14
        _report("pat-i", "ECHO", horizon + timedelta(days=-10), echo_a),
        _report("pat-i", "CHEST_XRAY", horizon + timedelta(days=-6), xray),
        _report("pat-j", "ECHO", horizon + timedelta(days=-12), echo_tee),
        _report("pat-j", "ECG", horizon + timedelta(days=-3), ecg),
        _report("pat-j", "AGREEMENT", horizon + timedelta(days=-2), agreement),
    ]

    clearances = [
        _clearance("pat-a", "GRANTED", planned + timedelta(days=-3), ()),
        _clearance(
            "pat-b",
            "CONDITIONAL",
            planned + timedelta(days=-1),
            ("Kalium korrigieren",),
        ),
        _clearance("pat-d", "GRANTED", planned + timedelta(days=-2), ()),
        _clearance("pat-e", "GRANTED", planned + timedelta(days=-2), ()),
        _clearance("pat-f", "GRANTED", planned + timedelta(days=-1), ()),
        _clearance("pat-g", "GRANTED", anchor + timedelta(days=-2), ()),
        _clearance(
            "pat-h",
            "CONDITIONAL",
            anchor + timedelta(days=-1),
            ("Hb kontrollieren",),
        ),
    ]

    medications = [
        Medication(
            id="med-a-1",
            patient_id="pat-a",
            name="Test-ASS",
            drug_class="ANTIPLATELET",
            status="PAUSED",
            paused_since=planned + timedelta(days=-5),
            source="synthetic-seed",
        ),
        Medication(
            id="med-d-1",
            patient_id="pat-d",
            name="Test-Apixaban",
            drug_class="DOAC",
            status="ACTIVE",
            paused_since=None,
            source="synthetic-seed",
        ),
        Medication(
            id="med-h-1",
            patient_id="pat-h",
            name="Test-Rivaroxaban",
            drug_class="DOAC",
            status="ACTIVE",
            paused_since=None,
            source="synthetic-seed",
        ),
    ]

    return DemoWorld(
        patients=patients,
        procedures=procedures,
        observations=observations,
        reports=reports,
        clearances=clearances,
        medications=medications,
    )


def _labs(
    patient_id: str,
    when: date,
    overrides: dict[str, tuple[float, str]] | None = None,
) -> list[Observation]:
    values = dict(NORMAL_LABS)
    if overrides:
        values.update(overrides)
    rows = []
    for code, (value, unit) in values.items():
        rows.append(
            Observation(
                id=f"obs-{patient_id}-{code}",
                patient_id=patient_id,
                code=code,
                value=value,
                unit=unit,
                effective_date=when,
                source="synthetic-seed",
            )
        )
    return rows


def _report(patient_id: str, report_type: str, when: date, text: str) -> DiagnosticReport:
    return DiagnosticReport(
        id=f"rep-{patient_id}-{report_type.lower()}",
        patient_id=patient_id,
        report_type=report_type,
        report_date=when,
        conclusion_text=text,
        source="synthetic-seed",
        evidence=text[:180],
    )


def _clearance(patient_id, status, when, conditions) -> AnesthesiaClearance:
    return AnesthesiaClearance(
        id=f"clr-{patient_id}",
        patient_id=patient_id,
        status=status,
        clearance_date=when,
        asa_class="ASA II",
        conditions=tuple(conditions),
        anesthetist="Dr. Test Anaesthesie",
        source="synthetic-seed",
    )
