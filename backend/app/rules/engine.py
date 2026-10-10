"""Deterministic pre-procedure checks.

Clinical cutoffs are read from the requirements and thresholds documents.
This module only applies those documents and the fixed category rules.
"""

from __future__ import annotations

from datetime import date, timedelta

from app.domain import (
    AnesthesiaClearance,
    DiagnosticReport,
    Finding,
    Medication,
    Observation,
)

CRITICAL = "CRITICAL"
WARNING = "WARNING"

MISSING = "MISSING"
OUTDATED = "OUTDATED"
ABNORMAL = "ABNORMAL"
IMPLAUSIBLE = "IMPLAUSIBLE"
INCONSISTENT = "INCONSISTENT"
CLEARANCE = "CLEARANCE"

ROLE_ANESTHESIA = "Anästhesie"
ROLE_PHYSICIAN = "Arzt"
ROLE_COORDINATION = "Pflege/Koordination"


def overall_status(findings: list[Finding]) -> str:
    # Severity drives readiness: MISSING+WARNING (e.g. post-procedure items
    # not yet due) stays yellow; MISSING+CRITICAL remains red.
    if any(f.severity == CRITICAL for f in findings):
        return "RED"
    if any(f.severity == WARNING or f.category == OUTDATED for f in findings):
        return "YELLOW"
    return "GREEN"


def item_state(item: str, findings: list[Finding]) -> str:
    related = [f for f in findings if f.item == item]
    if any(f.category == MISSING for f in related):
        return "missing"
    if any(f.severity == CRITICAL for f in related):
        return "critical"
    if any(f.category == OUTDATED for f in related):
        return "outdated"
    if related:
        return "warning"
    return "complete"


def evaluate_case(
    *,
    patient_id: str,
    procedure_type: str,
    planned_date: date,
    observations: list[Observation],
    reports: list[DiagnosticReport],
    clearance: AnesthesiaClearance | None,
    medications: list[Medication],
    requirements_doc: dict,
    thresholds_doc: dict,
    as_of: date | None = None,
) -> list[Finding]:
    procedure_rules = (requirements_doc.get("procedures") or {}).get(procedure_type)
    if not procedure_rules:
        label = procedure_type or "procedure"
        return [
            _finding(
                category=INCONSISTENT,
                severity=WARNING,
                item="config.requirements",
                source_ref="config:requirements",
                de=f"Keine Anforderungen für {label} konfiguriert.",
                en=f"No requirements are configured for {label}.",
            )
        ]

    labels = requirements_doc.get("labels") or {}
    labs_cfg = thresholds_doc.get("labs") or {}
    findings: list[Finding] = []
    check_day = as_of or planned_date

    for rule in procedure_rules:
        item = str(rule.get("item") or "")
        required = bool(rule.get("required", True))
        max_age = rule.get("maxAgeDays")
        must_mention = rule.get("mustMention")
        timing = str(rule.get("timing") or "pre").lower()
        offset_days = rule.get("offsetDays")
        if item.startswith("lab."):
            findings.extend(
                _check_lab(
                    code=item.split(".", 1)[1],
                    item=item,
                    required=required,
                    max_age=max_age,
                    patient_id=patient_id,
                    procedure_type=procedure_type,
                    planned_date=planned_date,
                    observations=observations,
                    spec=labs_cfg.get(item.split(".", 1)[1]) or {},
                )
            )
        elif item.startswith("report."):
            findings.extend(
                _check_report(
                    report_type=item.split(".", 1)[1],
                    item=item,
                    required=required,
                    max_age=max_age,
                    must_mention=must_mention,
                    timing=timing,
                    offset_days=offset_days,
                    patient_id=patient_id,
                    procedure_type=procedure_type,
                    planned_date=planned_date,
                    as_of=check_day,
                    reports=reports,
                    label=labels.get(item) or {},
                )
            )
        elif item.startswith("clearance."):
            findings.extend(
                _check_clearance(
                    item=item,
                    required=required,
                    max_age=max_age,
                    procedure_type=procedure_type,
                    planned_date=planned_date,
                    clearance=clearance,
                    label=labels.get(item) or {},
                )
            )

    findings.extend(
        _check_medications(
            patient_id=patient_id,
            procedure_type=procedure_type,
            planned_date=planned_date,
            observations=observations,
            medications=medications,
            labs_cfg=labs_cfg,
            consistency=thresholds_doc.get("consistency") or {},
        )
    )
    return _dedupe(findings)


def _check_lab(
    *,
    code: str,
    item: str,
    required: bool,
    max_age,
    patient_id: str,
    procedure_type: str,
    planned_date: date,
    observations: list[Observation],
    spec: dict,
) -> list[Finding]:
    label_de, label_en = _lab_labels(code, spec)
    rows = [o for o in observations if o.patient_id == patient_id and o.code == code]
    findings: list[Finding] = []
    if not rows:
        if required:
            findings.append(
                _finding(
                    category=MISSING,
                    severity=CRITICAL,
                    item=item,
                    source_ref=item,
                    de=(
                        f"{label_de} fehlt – bitte Labor vor {procedure_type} "
                        f"am {_fmt(planned_date)} abnehmen."
                    ),
                    en=(
                        f"{label_en} is missing – please draw blood before "
                        f"{procedure_type} on {_fmt(planned_date)}."
                    ),
                )
            )
        return findings

    for row in rows:
        if row.effective_date > planned_date:
            findings.append(
                _finding(
                    category=IMPLAUSIBLE,
                    severity=CRITICAL,
                    item=item,
                    source_ref=row.id,
                    de=(
                        f"{label_de} ist auf den {_fmt(row.effective_date)} datiert, "
                        f"nach dem geplanten {procedure_type} am {_fmt(planned_date)}."
                    ),
                    en=(
                        f"{label_en} is dated {_fmt(row.effective_date)}, after the "
                        f"planned {procedure_type} on {_fmt(planned_date)}."
                    ),
                )
            )

    usable = [r for r in rows if r.effective_date <= planned_date]
    if not usable:
        return findings

    findings.extend(_duplicate_findings(item, label_de, label_en, usable))
    latest_day = max(r.effective_date for r in usable)
    latest_rows = [r for r in usable if r.effective_date == latest_day]
    for row in latest_rows:
        findings.extend(
            _value_findings(
                row=row,
                item=item,
                label_de=label_de,
                label_en=label_en,
                spec=spec,
            )
        )

    if max_age is not None and (planned_date - latest_day).days > int(max_age):
        age = (planned_date - latest_day).days
        findings.append(
            _finding(
                category=OUTDATED,
                severity=WARNING,
                item=item,
                source_ref=latest_rows[0].id,
                de=(
                    f"{label_de}: veraltet ({age} Tage, erlaubt {int(max_age)}) "
                    f"– bitte vor {procedure_type} am {_fmt(planned_date)} wiederholen."
                ),
                en=(
                    f"{label_en} is outdated ({age} days, allowed {int(max_age)}) "
                    f"– please repeat before {procedure_type} on {_fmt(planned_date)}."
                ),
            )
        )
    return findings


def _value_findings(
    *,
    row: Observation,
    item: str,
    label_de: str,
    label_en: str,
    spec: dict,
) -> list[Finding]:
    expected = spec.get("unit")
    if expected and not _units_match(row.unit, str(expected)):
        return [
            _finding(
                category=IMPLAUSIBLE,
                severity=WARNING,
                item=item,
                source_ref=row.id,
                de=(
                    f"{label_de}: Einheit „{row.unit}“ passt nicht zur "
                    f"erwarteten Einheit „{expected}“."
                ),
                en=(
                    f"{label_en}: unit “{row.unit}” does not match the "
                    f"expected unit “{expected}”."
                ),
            )
        ]
    if row.value is None:
        return [
            _finding(
                category=IMPLAUSIBLE,
                severity=WARNING,
                item=item,
                source_ref=row.id,
                de=f"{label_de}: kein numerischer Wert dokumentiert.",
                en=f"{label_en}: no numeric value documented.",
            )
        ]

    low_b = spec.get("implausibleLow")
    high_b = spec.get("implausibleHigh")
    if (low_b is not None and row.value < float(low_b)) or (
        high_b is not None and row.value > float(high_b)
    ):
        return [
            _finding(
                category=IMPLAUSIBLE,
                severity=WARNING,
                item=item,
                source_ref=row.id,
                de=(
                    f"{label_de} { _num(row.value) } {row.unit} ist physiologisch "
                    f"nicht plausibel."
                ),
                en=(
                    f"{label_en} { _num(row.value) } {row.unit} is not "
                    f"physiologically plausible."
                ),
            )
        ]

    crit_low = spec.get("criticalLow")
    crit_high = spec.get("criticalHigh")
    if crit_low is not None and row.value < float(crit_low):
        return [_abnormal(row, item, label_de, label_en, CRITICAL, crit_low, "low")]
    if crit_high is not None and row.value > float(crit_high):
        return [_abnormal(row, item, label_de, label_en, CRITICAL, crit_high, "high")]

    low = spec.get("low")
    high = spec.get("high")
    if low is not None and row.value < float(low):
        return [_abnormal(row, item, label_de, label_en, WARNING, low, "low")]
    if high is not None and row.value > float(high):
        return [_abnormal(row, item, label_de, label_en, WARNING, high, "high")]
    return []


def _abnormal(row, item, label_de, label_en, severity, bound, side) -> Finding:
    kind_de = "kritisch" if severity == CRITICAL else "auffällig"
    kind_en = "critical" if severity == CRITICAL else "abnormal"
    direction_de = "unter" if side == "low" else "über"
    direction_en = "below" if side == "low" else "above"
    return _finding(
        category=ABNORMAL,
        severity=severity,
        item=item,
        source_ref=row.id,
        de=(
            f"{label_de} {_num(row.value)} {row.unit} ist {kind_de} "
            f"({direction_de} {_num(bound)})."
        ),
        en=(
            f"{label_en} {_num(row.value)} {row.unit} is {kind_en} "
            f"({direction_en} {_num(bound)})."
        ),
    )


def _duplicate_findings(item, label_de, label_en, rows: list[Observation]) -> list[Finding]:
    findings: list[Finding] = []
    by_day: dict[date, list[Observation]] = {}
    for row in rows:
        by_day.setdefault(row.effective_date, []).append(row)
    for day, group in by_day.items():
        values = {None if r.value is None else round(float(r.value), 4) for r in group}
        if len(group) > 1 and len(values) > 1:
            findings.append(
                _finding(
                    category=IMPLAUSIBLE,
                    severity=WARNING,
                    item=item,
                    source_ref=group[0].id,
                    de=(
                        f"{label_de}: widersprüchliche Werte am {_fmt(day)} "
                        f"({', '.join(_num(v) if v is not None else '–' for v in values)})."
                    ),
                    en=(
                        f"{label_en}: conflicting values on {_fmt(day)} "
                        f"({', '.join(_num(v) if v is not None else '–' for v in values)})."
                    ),
                )
            )
    return findings


def _check_report(
    *,
    report_type: str,
    item: str,
    required: bool,
    max_age,
    must_mention,
    timing: str,
    offset_days,
    patient_id: str,
    procedure_type: str,
    planned_date: date,
    as_of: date,
    reports: list[DiagnosticReport],
    label: dict,
) -> list[Finding]:
    label_de, label_en = _pair(label, report_type)
    rows = [
        r for r in reports if r.patient_id == patient_id and r.report_type == report_type
    ]
    if timing == "post":
        return _check_report_post(
            report_type=report_type,
            item=item,
            required=required,
            must_mention=must_mention,
            offset_days=1 if offset_days is None else int(offset_days),
            procedure_type=procedure_type,
            planned_date=planned_date,
            as_of=as_of,
            rows=rows,
            label_de=label_de,
            label_en=label_en,
        )

    findings: list[Finding] = []
    if not rows:
        if required:
            if report_type == "AGREEMENT":
                de = (
                    f"{label_de} fehlt – der Patient muss vor {procedure_type} "
                    f"am {_fmt(planned_date)} unterschreiben."
                )
                en = (
                    f"{label_en} is missing – the patient must sign it before "
                    f"{procedure_type} on {_fmt(planned_date)}."
                )
            else:
                de = (
                    f"{label_de} fehlt – bitte vor {procedure_type} "
                    f"am {_fmt(planned_date)} anmelden."
                )
                en = (
                    f"{label_en} is missing – please schedule it before "
                    f"{procedure_type} on {_fmt(planned_date)}."
                )
            findings.append(
                _finding(
                    category=MISSING,
                    severity=CRITICAL,
                    item=item,
                    source_ref=item,
                    de=de,
                    en=en,
                )
            )
        return findings

    for row in rows:
        if row.report_date is None:
            findings.append(
                _finding(
                    category=IMPLAUSIBLE,
                    severity=WARNING,
                    item=item,
                    source_ref=row.id,
                    de=f"{label_de}: kein Befunddatum dokumentiert.",
                    en=f"{label_en}: no report date documented.",
                )
            )
        elif row.report_date > planned_date:
            findings.append(
                _finding(
                    category=IMPLAUSIBLE,
                    severity=CRITICAL,
                    item=item,
                    source_ref=row.id,
                    de=(
                        f"{label_de} ist auf den {_fmt(row.report_date)} datiert, "
                        f"nach dem geplanten {procedure_type} am {_fmt(planned_date)}."
                    ),
                    en=(
                        f"{label_en} is dated {_fmt(row.report_date)}, after the "
                        f"planned {procedure_type} on {_fmt(planned_date)}."
                    ),
                )
            )

    usable = [r for r in rows if r.report_date is not None and r.report_date <= planned_date]
    if not usable:
        return findings

    latest = max(usable, key=lambda r: r.report_date or planned_date)
    if max_age is not None and latest.report_date is not None:
        age = (planned_date - latest.report_date).days
        if age > int(max_age):
            findings.append(
                _finding(
                    category=OUTDATED,
                    severity=WARNING,
                    item=item,
                    source_ref=latest.id,
                    de=(
                        f"{label_de}: veraltet ({age} Tage, erlaubt {int(max_age)}) "
                        f"– bitte vor {procedure_type} am {_fmt(planned_date)} wiederholen."
                    ),
                    en=(
                        f"{label_en} is outdated ({age} days, allowed {int(max_age)}) "
                        f"– please repeat before {procedure_type} on {_fmt(planned_date)}."
                    ),
                )
            )
    findings.extend(
        _must_mention_findings(
            must_mention=must_mention,
            latest=latest,
            item=item,
            label_de=label_de,
            label_en=label_en,
            procedure_type=procedure_type,
            planned_date=planned_date,
        )
    )
    return findings


def _check_report_post(
    *,
    report_type: str,
    item: str,
    required: bool,
    must_mention,
    offset_days: int,
    procedure_type: str,
    planned_date: date,
    as_of: date,
    rows: list[DiagnosticReport],
    label_de: str,
    label_en: str,
) -> list[Finding]:
    target = planned_date + timedelta(days=offset_days)
    findings: list[Finding] = []

    for row in rows:
        if row.report_date is None:
            findings.append(
                _finding(
                    category=IMPLAUSIBLE,
                    severity=WARNING,
                    item=item,
                    source_ref=row.id,
                    de=f"{label_de}: kein Befunddatum dokumentiert.",
                    en=f"{label_en}: no report date documented.",
                )
            )
        elif row.report_date < planned_date:
            findings.append(
                _finding(
                    category=INCONSISTENT,
                    severity=WARNING,
                    item=item,
                    source_ref=row.id,
                    de=(
                        f"{label_de} ist auf den {_fmt(row.report_date)} datiert – "
                        f"erwartet am {_fmt(target)} (nach {procedure_type})."
                    ),
                    en=(
                        f"{label_en} is dated {_fmt(row.report_date)} – "
                        f"expected on {_fmt(target)} (after {procedure_type})."
                    ),
                )
            )

    usable = [
        r
        for r in rows
        if r.report_date is not None and r.report_date >= target
    ]
    if not usable:
        if not required:
            return findings
        pending = as_of < target
        severity = WARNING if pending else CRITICAL
        when_de = (
            "Tag nach dem Eingriff"
            if offset_days == 1
            else f"{offset_days} Tage nach dem Eingriff"
        )
        when_en = (
            "day after the procedure"
            if offset_days == 1
            else f"{offset_days} days after the procedure"
        )
        de = (
            f"{label_de} fehlt – geplant für den {_fmt(target)} "
            f"({when_de}, {procedure_type} am {_fmt(planned_date)})."
        )
        en = (
            f"{label_en} is missing – scheduled for {_fmt(target)} "
            f"({when_en}, {procedure_type} on {_fmt(planned_date)})."
        )
        if not pending:
            de = (
                f"{label_de} fehlt – bitte am {_fmt(target)} "
                f"nach {procedure_type} nachholen."
            )
            en = (
                f"{label_en} is missing – please obtain it on {_fmt(target)} "
                f"after {procedure_type}."
            )
        findings.append(
            _finding(
                category=MISSING,
                severity=severity,
                item=item,
                source_ref=item,
                de=de,
                en=en,
            )
        )
        return findings

    latest = max(usable, key=lambda r: r.report_date or target)
    findings.extend(
        _must_mention_findings(
            must_mention=must_mention,
            latest=latest,
            item=item,
            label_de=label_de,
            label_en=label_en,
            procedure_type=procedure_type,
            planned_date=planned_date,
        )
    )
    return findings


def _must_mention_findings(
    *,
    must_mention,
    latest: DiagnosticReport,
    item: str,
    label_de: str,
    label_en: str,
    procedure_type: str,
    planned_date: date,
) -> list[Finding]:
    if not must_mention:
        return []
    text = latest.conclusion_text or ""
    if str(must_mention).lower() in text.lower():
        return []
    return [
        _finding(
            category=MISSING,
            severity=CRITICAL,
            item=item,
            source_ref=latest.id,
            de=(
                f"{must_mention}-Hinweis fehlt in der {label_de} – bitte vor "
                f"{procedure_type} am {_fmt(planned_date)} ergänzen."
            ),
            en=(
                f"{must_mention} is not mentioned in the {label_en} – please "
                f"add it before {procedure_type} on {_fmt(planned_date)}."
            ),
        )
    ]


def _check_clearance(
    *,
    item: str,
    required: bool,
    max_age,
    procedure_type: str,
    planned_date: date,
    clearance: AnesthesiaClearance | None,
    label: dict,
) -> list[Finding]:
    label_de, label_en = _pair(label, "Anesthesia clearance")
    if clearance is None or clearance.status == "MISSING":
        if not required:
            return []
        return [
            _finding(
                category=CLEARANCE,
                severity=CRITICAL,
                item=item,
                source_ref=clearance.id if clearance else item,
                role=ROLE_ANESTHESIA,
                de=(
                    f"{label_de} fehlt – bitte vor {procedure_type} "
                    f"am {_fmt(planned_date)} einholen."
                ),
                en=(
                    f"{label_en} is missing – please obtain it before "
                    f"{procedure_type} on {_fmt(planned_date)}."
                ),
            )
        ]

    findings: list[Finding] = []
    if clearance.clearance_date and clearance.clearance_date > planned_date:
        findings.append(
            _finding(
                category=IMPLAUSIBLE,
                severity=CRITICAL,
                item=item,
                source_ref=clearance.id,
                role=ROLE_ANESTHESIA,
                de=(
                    f"{label_de} ist auf den {_fmt(clearance.clearance_date)} datiert, "
                    f"nach dem geplanten Eingriff."
                ),
                en=(
                    f"{label_en} is dated {_fmt(clearance.clearance_date)}, "
                    f"after the planned procedure."
                ),
            )
        )
    if (
        max_age is not None
        and clearance.clearance_date is not None
        and (planned_date - clearance.clearance_date).days > int(max_age)
    ):
        age = (planned_date - clearance.clearance_date).days
        findings.append(
            _finding(
                category=OUTDATED,
                severity=WARNING,
                item=item,
                source_ref=clearance.id,
                role=ROLE_ANESTHESIA,
                de=(
                    f"{label_de}: veraltet ({age} Tage, erlaubt {int(max_age)})."
                ),
                en=(
                    f"{label_en} is outdated ({age} days, allowed {int(max_age)})."
                ),
            )
        )
    if clearance.status == "CONDITIONAL":
        open_items = [c for c in clearance.conditions if c.strip()]
        detail = "; ".join(open_items) if open_items else "keine Auflage dokumentiert"
        detail_en = "; ".join(open_items) if open_items else "no condition documented"
        findings.append(
            _finding(
                category=CLEARANCE,
                severity=WARNING,
                item=item,
                source_ref=clearance.id,
                role=ROLE_ANESTHESIA,
                de=f"{label_de} nur bedingt: {detail}.",
                en=f"{label_en} is conditional: {detail_en}.",
            )
        )
    elif clearance.status != "GRANTED":
        findings.append(
            _finding(
                category=CLEARANCE,
                severity=WARNING,
                item=item,
                source_ref=clearance.id,
                role=ROLE_ANESTHESIA,
                de=f"{label_de}: unbekannter Status „{clearance.status}“.",
                en=f"{label_en}: unknown status “{clearance.status}”.",
            )
        )
    return findings


def _check_medications(
    *,
    patient_id: str,
    procedure_type: str,
    planned_date: date,
    observations: list[Observation],
    medications: list[Medication],
    labs_cfg: dict,
    consistency: dict,
) -> list[Finding]:
    pause_classes = {str(c).upper() for c in consistency.get("pauseRequiredClasses") or []}
    egfr_code = str(consistency.get("egfrCode") or "egfr")
    egfr_min = consistency.get("metforminEgfrMin")
    findings: list[Finding] = []
    for med in medications:
        if med.patient_id != patient_id:
            continue
        if (
            med.drug_class.upper() in pause_classes
            and med.status == "ACTIVE"
            and med.paused_since is None
        ):
            findings.append(
                _finding(
                    category=INCONSISTENT,
                    severity=CRITICAL,
                    item=f"medication.{med.drug_class.lower()}",
                    source_ref=med.id,
                    de=(
                        f"{med.name} ({med.drug_class}) ist weiter aktiv, ohne "
                        f"dokumentierte Pause vor {procedure_type} am {_fmt(planned_date)}."
                    ),
                    en=(
                        f"{med.name} ({med.drug_class}) is still active, with no "
                        f"documented pause before {procedure_type} on {_fmt(planned_date)}."
                    ),
                )
            )
        if (
            med.drug_class.upper() == "METFORMIN"
            and med.status == "ACTIVE"
            and egfr_min is not None
        ):
            egfr = _latest_usable(
                [o for o in observations if o.patient_id == patient_id and o.code == egfr_code],
                planned_date,
            )
            spec = labs_cfg.get(egfr_code) or {}
            if (
                egfr is not None
                and egfr.value is not None
                and _units_match(egfr.unit, str(spec.get("unit") or egfr.unit))
                and egfr.value < float(egfr_min)
            ):
                findings.append(
                    _finding(
                        category=INCONSISTENT,
                        severity=WARNING,
                        item="medication.metformin",
                        source_ref=med.id,
                        de=(
                            f"Metformin ist aktiv bei eGFR {_num(egfr.value)} "
                            f"(unter {_num(egfr_min)}) vor {procedure_type}."
                        ),
                        en=(
                            f"Metformin is active with eGFR {_num(egfr.value)} "
                            f"(below {_num(egfr_min)}) before {procedure_type}."
                        ),
                    )
                )
    return findings


def _latest_usable(rows: list[Observation], planned_date: date) -> Observation | None:
    usable = [r for r in rows if r.effective_date <= planned_date]
    if not usable:
        return None
    return max(usable, key=lambda r: r.effective_date)


def _finding(
    *,
    category: str,
    severity: str,
    item: str,
    source_ref: str,
    de: str,
    en: str,
    role: str | None = None,
) -> Finding:
    return Finding(
        category=category,
        severity=severity,
        item=item,
        message_de=de,
        message_en=en,
        source_ref=source_ref,
        role=role or _role(item, category),
    )


def _role(item: str, category: str) -> str:
    if category == CLEARANCE or item.startswith("clearance."):
        return ROLE_ANESTHESIA
    if category in {ABNORMAL, IMPLAUSIBLE, INCONSISTENT}:
        return ROLE_PHYSICIAN
    return ROLE_COORDINATION


def _dedupe(findings: list[Finding]) -> list[Finding]:
    seen: set[tuple] = set()
    unique: list[Finding] = []
    for finding in findings:
        key = (finding.category, finding.item, finding.source_ref, finding.message_de)
        if key in seen:
            continue
        seen.add(key)
        unique.append(finding)
    return unique


def _lab_labels(code: str, spec: dict) -> tuple[str, str]:
    return str(spec.get("labelDe") or code), str(spec.get("labelEn") or code)


def _pair(label: dict, fallback: str) -> tuple[str, str]:
    return str(label.get("de") or fallback), str(label.get("en") or fallback)


def _units_match(actual: str, expected: str) -> bool:
    return _norm_unit(actual) == _norm_unit(expected)


def _norm_unit(unit: str) -> str:
    return (
        unit.strip()
        .lower()
        .replace("µ", "u")
        .replace("μ", "u")
        .replace(" ", "")
    )


def _fmt(value: date) -> str:
    return value.strftime("%d.%m.%Y")


def _num(value) -> str:
    number = float(value)
    if number.is_integer():
        return str(int(number))
    text = f"{number:.4f}".rstrip("0").rstrip(".")
    return text
