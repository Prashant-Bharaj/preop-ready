"""Every rule category, plus the six demo scenarios."""

from datetime import date, timedelta

from app.config_defaults import default_requirements, default_thresholds
from app.demo_data import build_demo_world
from app.domain import (
    AnesthesiaClearance,
    DiagnosticReport,
    Medication,
    Observation,
)
from app.rules.engine import evaluate_case, overall_status

TODAY = date(2026, 10, 10)
PLANNED = TODAY + timedelta(days=1)


def _eval(world, procedure_id):
    procedure = next(p for p in world.procedures if p.id == procedure_id)
    clearance = next(
        (c for c in world.clearances if c.patient_id == procedure.patient_id),
        None,
    )
    return evaluate_case(
        patient_id=procedure.patient_id,
        procedure_type=procedure.procedure_type,
        planned_date=procedure.planned_date,
        observations=world.observations,
        reports=world.reports,
        clearance=clearance,
        medications=world.medications,
        requirements_doc=default_requirements(),
        thresholds_doc=default_thresholds(),
    )


def _base_kwargs(**overrides):
    payload = dict(
        patient_id="pat-x",
        procedure_type="TAVI",
        planned_date=PLANNED,
        observations=[],
        reports=[],
        clearance=None,
        medications=[],
        requirements_doc=default_requirements(),
        thresholds_doc=default_thresholds(),
    )
    payload.update(overrides)
    return payload


def _lab(code, value, unit, when=None, **kwargs):
    return Observation(
        id=kwargs.pop("id", f"obs-{code}"),
        patient_id=kwargs.pop("patient_id", "pat-x"),
        code=code,
        value=value,
        unit=unit,
        effective_date=when or (PLANNED - timedelta(days=1)),
        source="test",
        **kwargs,
    )


def _complete_labs(when=None, **overrides):
    specs = default_thresholds()["labs"]
    rows = []
    for code, spec in specs.items():
        value = overrides.get(code, (float(spec["low"]) + float(spec["high"])) / 2)
        rows.append(_lab(code, value, spec["unit"], when))
    return rows


def _reports(echo_text="LVEF 60 %. Aortenklappe stenosiert.", echo_age=10, xray_age=3, ecg_age=1):
    return [
        DiagnosticReport(
            "rep-echo",
            "pat-x",
            "ECHO",
            PLANNED - timedelta(days=echo_age),
            echo_text,
            "test",
        ),
        DiagnosticReport(
            "rep-xray",
            "pat-x",
            "CHEST_XRAY",
            PLANNED - timedelta(days=xray_age),
            "Keine Infiltrate.",
            "test",
        ),
        DiagnosticReport(
            "rep-ecg",
            "pat-x",
            "ECG",
            PLANNED - timedelta(days=ecg_age),
            "Sinusrhythmus.",
            "test",
        ),
    ]


def _granted():
    return AnesthesiaClearance(
        "clr-x",
        "pat-x",
        "GRANTED",
        PLANNED - timedelta(days=1),
        "ASA II",
        (),
        "Dr. Test Anaesthesie",
        "test",
    )


def test_missing_echo_is_red():
    findings = evaluate_case(
        **_base_kwargs(
            observations=_complete_labs(),
            reports=[r for r in _reports() if r.report_type != "ECHO"],
            clearance=_granted(),
        )
    )
    missing = [f for f in findings if f.category == "MISSING" and f.item == "report.ECHO"]
    assert missing
    assert "Echokardiographie fehlt" in missing[0].message_de
    assert missing[0].role == "Pflege/Koordination"
    assert overall_status(findings) == "RED"


def test_outdated_lab_is_yellow():
    findings = evaluate_case(
        **_base_kwargs(
            observations=_complete_labs(PLANNED - timedelta(days=10)),
            reports=_reports(),
            clearance=_granted(),
        )
    )
    outdated = [f for f in findings if f.category == "OUTDATED" and f.item == "lab.potassium"]
    assert outdated
    assert outdated[0].severity == "WARNING"
    assert overall_status(findings) == "YELLOW"


def test_abnormal_warning_and_critical():
    labs = [row for row in _complete_labs() if row.code != "sodium"]
    labs.append(_lab("sodium", 150, "mmol/L"))
    warning_case = evaluate_case(
        **_base_kwargs(observations=labs, reports=_reports(), clearance=_granted())
    )
    sodium = [f for f in warning_case if f.item == "lab.sodium"]
    assert sodium and sodium[0].category == "ABNORMAL" and sodium[0].severity == "WARNING"
    assert overall_status(warning_case) == "YELLOW"

    labs = [row for row in _complete_labs() if row.code != "potassium"]
    labs.append(_lab("potassium", 2.4, "mmol/L"))
    critical_case = evaluate_case(
        **_base_kwargs(observations=labs, reports=_reports(), clearance=_granted())
    )
    potassium = [f for f in critical_case if f.item == "lab.potassium"]
    assert potassium[0].severity == "CRITICAL"
    assert overall_status(critical_case) == "RED"


def test_unit_mismatch_is_yellow_not_a_range_breach():
    labs = [row for row in _complete_labs() if row.code != "creatinine"]
    labs.append(_lab("creatinine", 1.1, "mg/dL"))
    findings = evaluate_case(
        **_base_kwargs(observations=labs, reports=_reports(), clearance=_granted())
    )
    creatinine = [f for f in findings if f.item == "lab.creatinine"]
    assert len(creatinine) == 1
    assert creatinine[0].category == "IMPLAUSIBLE"
    assert creatinine[0].severity == "WARNING"
    assert overall_status(findings) == "YELLOW"


def test_implausible_bounds_are_warning():
    labs = [row for row in _complete_labs() if row.code != "potassium"]
    labs.append(_lab("potassium", 0.2, "mmol/L"))
    findings = evaluate_case(
        **_base_kwargs(observations=labs, reports=_reports(), clearance=_granted())
    )
    potassium = [f for f in findings if f.item == "lab.potassium"]
    assert potassium[0].category == "IMPLAUSIBLE"
    assert potassium[0].severity == "WARNING"


def test_report_dated_after_procedure_is_red():
    reports = [r for r in _reports() if r.report_type != "CHEST_XRAY"]
    reports.append(
        DiagnosticReport(
            "rep-xray",
            "pat-x",
            "CHEST_XRAY",
            PLANNED + timedelta(days=1),
            "Keine Infiltrate.",
            "test",
        )
    )
    findings = evaluate_case(
        **_base_kwargs(observations=_complete_labs(), reports=reports, clearance=_granted())
    )
    future = [f for f in findings if f.item == "report.CHEST_XRAY"]
    assert future[0].category == "IMPLAUSIBLE"
    assert future[0].severity == "CRITICAL"
    assert overall_status(findings) == "RED"
    assert not any(f.category == "MISSING" and f.item == "report.CHEST_XRAY" for f in findings)


def test_patient_id_mismatch_is_red():
    reports = _reports()
    reports[0] = DiagnosticReport(
        "rep-echo",
        "pat-x",
        "ECHO",
        PLANNED - timedelta(days=5),
        "LVEF 60 %.",
        "test",
        document_patient_id="pat-other",
    )
    findings = evaluate_case(
        **_base_kwargs(observations=_complete_labs(), reports=reports, clearance=_granted())
    )
    mismatch = [f for f in findings if "stimmt nicht" in f.message_de]
    assert mismatch
    assert mismatch[0].severity == "CRITICAL"
    assert overall_status(findings) == "RED"


def test_duplicate_conflicting_values_are_yellow():
    labs = [row for row in _complete_labs() if row.code != "potassium"]
    day = PLANNED - timedelta(days=1)
    labs.append(_lab("potassium", 4.0, "mmol/L", day, id="obs-k1"))
    labs.append(_lab("potassium", 4.8, "mmol/L", day, id="obs-k2"))
    findings = evaluate_case(
        **_base_kwargs(observations=labs, reports=_reports(), clearance=_granted())
    )
    dupes = [f for f in findings if "widersprüchliche" in f.message_de]
    assert dupes
    assert dupes[0].severity == "WARNING"
    assert overall_status(findings) == "YELLOW"


def test_active_doac_without_pause_is_red_and_paused_is_clean():
    active = Medication("med-1", "pat-x", "Test-Apixaban", "DOAC", "ACTIVE", None, "test")
    findings = evaluate_case(
        **_base_kwargs(
            observations=_complete_labs(),
            reports=_reports(),
            clearance=_granted(),
            medications=[active],
        )
    )
    meds = [f for f in findings if f.category == "INCONSISTENT"]
    assert meds and meds[0].severity == "CRITICAL"
    assert "Pause" in meds[0].message_de
    assert overall_status(findings) == "RED"

    paused = Medication(
        "med-1",
        "pat-x",
        "Test-Apixaban",
        "DOAC",
        "PAUSED",
        PLANNED - timedelta(days=2),
        "test",
    )
    clean = evaluate_case(
        **_base_kwargs(
            observations=_complete_labs(),
            reports=_reports(),
            clearance=_granted(),
            medications=[paused],
        )
    )
    assert overall_status(clean) == "GREEN"


def test_metformin_with_low_egfr_is_yellow():
    labs = [row for row in _complete_labs() if row.code != "egfr"]
    labs.append(_lab("egfr", 28, "mL/min/1.73m2"))
    med = Medication("med-m", "pat-x", "Test-Metformin", "METFORMIN", "ACTIVE", None, "test")
    findings = evaluate_case(
        **_base_kwargs(
            observations=labs,
            reports=_reports(),
            clearance=_granted(),
            medications=[med],
        )
    )
    meta = [f for f in findings if f.item == "medication.metformin"]
    assert meta and meta[0].severity == "WARNING"
    assert overall_status(findings) == "YELLOW"


def test_clearance_missing_is_red_and_conditional_is_yellow():
    missing = evaluate_case(
        **_base_kwargs(observations=_complete_labs(), reports=_reports(), clearance=None)
    )
    assert any(f.category == "CLEARANCE" and f.severity == "CRITICAL" for f in missing)
    assert missing[0].role == "Anästhesie" or any(f.role == "Anästhesie" for f in missing)
    assert overall_status(missing) == "RED"

    conditional = AnesthesiaClearance(
        "clr-x",
        "pat-x",
        "CONDITIONAL",
        PLANNED - timedelta(days=1),
        "ASA III",
        ("Kalium korrigieren",),
        "Dr. Test Anaesthesie",
        "test",
    )
    flagged = evaluate_case(
        **_base_kwargs(
            observations=_complete_labs(),
            reports=_reports(),
            clearance=conditional,
        )
    )
    clearance = [f for f in flagged if f.category == "CLEARANCE"]
    assert clearance[0].severity == "WARNING"
    assert "Kalium korrigieren" in clearance[0].message_de
    assert overall_status(flagged) == "YELLOW"


def test_tee_mention_required_for_mteer_only():
    without_tee = evaluate_case(
        **_base_kwargs(
            procedure_type="M-TEER",
            observations=_complete_labs(),
            reports=_reports(echo_text="LVEF 50 %. Schwere Mitralinsuffizienz."),
            clearance=_granted(),
        )
    )
    assert any("TEE" in f.message_de and f.category == "MISSING" for f in without_tee)
    assert overall_status(without_tee) == "RED"

    with_tee = evaluate_case(
        **_base_kwargs(
            procedure_type="M-TEER",
            observations=_complete_labs(),
            reports=_reports(echo_text="TEE: schwere Mitralinsuffizienz. LVEF 50 %."),
            clearance=_granted(),
        )
    )
    assert overall_status(with_tee) == "GREEN"


def test_complete_case_is_green_and_not_a_clearance():
    findings = evaluate_case(
        **_base_kwargs(
            observations=_complete_labs(),
            reports=_reports(),
            clearance=_granted(),
        )
    )
    assert findings == []
    assert overall_status(findings) == "GREEN"


def test_demo_cohort_statuses():
    world = build_demo_world(TODAY)
    expected = {
        "proc-a": "GREEN",
        "proc-b": "YELLOW",
        "proc-c": "RED",
        "proc-d": "RED",
        "proc-e": "YELLOW",
        "proc-f": "RED",
    }
    for procedure_id, status in expected.items():
        findings = _eval(world, procedure_id)
        assert overall_status(findings) == status, procedure_id

    red_c = _eval(world, "proc-c")
    assert any(f.item == "report.ECHO" and f.category == "MISSING" for f in red_c)
    assert any(f.item == "lab.potassium" and f.severity == "CRITICAL" for f in red_c)
    assert any(f.category == "CLEARANCE" and f.severity == "CRITICAL" for f in red_c)

    yellow_b = _eval(world, "proc-b")
    assert any(f.category == "OUTDATED" for f in yellow_b)
    assert any("Kalium korrigieren" in f.message_de for f in yellow_b)

    red_d = _eval(world, "proc-d")
    assert any(f.category == "INCONSISTENT" and "Test-Apixaban" in f.message_de for f in red_d)

    yellow_e = _eval(world, "proc-e")
    assert any(f.item == "lab.creatinine" and f.category == "IMPLAUSIBLE" for f in yellow_e)

    red_f = _eval(world, "proc-f")
    assert any(f.item == "report.CHEST_XRAY" and f.severity == "CRITICAL" for f in red_f)


def test_thresholds_are_not_hardcoded_in_the_engine():
    changed = default_thresholds()
    changed["labs"]["sodium"]["high"] = 160
    labs = [row for row in _complete_labs() if row.code != "sodium"]
    labs.append(_lab("sodium", 150, "mmol/L"))
    findings = evaluate_case(
        **_base_kwargs(
            observations=labs,
            reports=_reports(),
            clearance=_granted(),
            thresholds_doc=changed,
        )
    )
    assert not any(f.item == "lab.sodium" for f in findings)
