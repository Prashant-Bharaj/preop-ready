"""Read and write clinical rows. The rule engine stays pure."""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from app.config_defaults import default_requirements, default_thresholds
from app.demo_data import DemoWorld, build_demo_world
from app.domain import (
    AnesthesiaClearance,
    DiagnosticReport,
    Finding,
    Medication,
    Observation,
)
from app.rules.engine import evaluate_case, item_state, overall_status

CLINIC_TZ = ZoneInfo("Europe/Berlin")


def clinic_today() -> date:
    return datetime.now(CLINIC_TZ).date()


def seed_if_empty(conn: sqlite3.Connection, today: date | None = None) -> bool:
    row = conn.execute("SELECT COUNT(*) AS n FROM patients").fetchone()
    if row["n"]:
        return False
    day = today or clinic_today()
    insert_world(conn, build_demo_world(day), as_of=day)
    return True


def reset_and_seed(conn: sqlite3.Connection, today: date | None = None) -> None:
    conn.execute("DELETE FROM tasks")
    conn.execute("DELETE FROM findings")
    conn.execute("DELETE FROM audit_events")
    conn.execute("DELETE FROM medications")
    conn.execute("DELETE FROM anesthesia_clearances")
    conn.execute("DELETE FROM diagnostic_reports")
    conn.execute("DELETE FROM observations")
    conn.execute("DELETE FROM procedures")
    conn.execute("DELETE FROM patients")
    conn.execute("DELETE FROM app_config")
    day = today or clinic_today()
    insert_world(conn, build_demo_world(day), as_of=day)


def insert_world(
    conn: sqlite3.Connection,
    world: DemoWorld,
    as_of: date | None = None,
) -> None:
    now = _now()
    check_day = as_of
    conn.execute(
        "INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)",
        ("requirements", json.dumps(default_requirements(), ensure_ascii=False), now),
    )
    conn.execute(
        "INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)",
        ("thresholds", json.dumps(default_thresholds(), ensure_ascii=False), now),
    )
    for patient in world.patients:
        conn.execute(
            "INSERT INTO patients (id, name, birth_date, sex, ward) VALUES (?, ?, ?, ?, ?)",
            (patient.id, patient.name, patient.birth_date.isoformat(), patient.sex, patient.ward),
        )
    for procedure in world.procedures:
        conn.execute(
            """
            INSERT INTO procedures (
                id, patient_id, procedure_type, planned_date, planned_time,
                operator, status, readiness
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                procedure.id,
                procedure.patient_id,
                procedure.procedure_type,
                procedure.planned_date.isoformat(),
                procedure.planned_time,
                procedure.operator,
                procedure.status,
                None,
            ),
        )
    for obs in world.observations:
        _insert_observation(conn, obs)
    for report in world.reports:
        _insert_report(conn, report, extracted=None)
    for clearance in world.clearances:
        _insert_clearance(conn, clearance)
    for med in world.medications:
        _insert_medication(conn, med)
    for procedure in world.procedures:
        run_check(conn, procedure.id, as_of=check_day)


def run_check(
    conn: sqlite3.Connection,
    procedure_id: str,
    as_of: date | None = None,
) -> dict:
    procedure = conn.execute(
        "SELECT * FROM procedures WHERE id = ?", (procedure_id,)
    ).fetchone()
    if procedure is None:
        return {}
    patient_id = procedure["patient_id"]
    findings = evaluate_case(
        patient_id=patient_id,
        procedure_type=procedure["procedure_type"],
        planned_date=date.fromisoformat(procedure["planned_date"]),
        observations=_observations_for(conn, patient_id),
        reports=_reports_for(conn, patient_id),
        clearance=_clearance_for(conn, patient_id),
        medications=_medications_for(conn, patient_id),
        requirements_doc=get_config(conn, "requirements"),
        thresholds_doc=get_config(conn, "thresholds"),
        as_of=as_of or clinic_today(),
    )
    readiness = _persist_findings(conn, procedure_id, patient_id, findings)
    open_issues = conn.execute(
        "SELECT COUNT(*) AS n FROM tasks WHERE procedure_id = ? AND status = 'OPEN'",
        (procedure_id,),
    ).fetchone()["n"]
    return {
        "procedureId": procedure_id,
        "readiness": readiness,
        "openIssues": open_issues,
        "findings": [_finding_dict(f, None) for f in findings],
    }


def run_check_all(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute("SELECT id FROM procedures ORDER BY planned_date, planned_time").fetchall()
    return [run_check(conn, row["id"]) for row in rows]


def list_procedures(conn: sqlite3.Connection, on: date) -> list[dict]:
    rows = conn.execute(
        """
        SELECT p.id, p.planned_time, p.planned_date, p.procedure_type, p.readiness,
               p.operator, p.confirmed_by, p.confirmed_at, p.patient_id,
               pt.name AS patient_name,
               (SELECT COUNT(*) FROM tasks t
                  WHERE t.procedure_id = p.id AND t.status = 'OPEN') AS open_issues,
               (SELECT c.status FROM anesthesia_clearances c
                  WHERE c.patient_id = p.patient_id) AS clearance_status
        FROM procedures p
        JOIN patients pt ON pt.id = p.patient_id
        WHERE p.planned_date = ?
        ORDER BY p.planned_time
        """,
        (on.isoformat(),),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "time": row["planned_time"],
            "date": row["planned_date"],
            "patientId": row["patient_id"],
            "patientName": row["patient_name"],
            "procedureType": row["procedure_type"],
            "readiness": row["readiness"] or "YELLOW",
            "openIssues": row["open_issues"],
            "clearance": row["clearance_status"] or "MISSING",
            "confirmed": bool(row["confirmed_at"]),
            "confirmedBy": row["confirmed_by"],
            "confirmedAt": row["confirmed_at"],
            "operator": row["operator"],
        }
        for row in rows
    ]


def get_patient(conn: sqlite3.Connection, patient_id: str) -> dict | None:
    patient = conn.execute("SELECT * FROM patients WHERE id = ?", (patient_id,)).fetchone()
    if patient is None:
        return None
    requirements = get_config(conn, "requirements")
    thresholds = get_config(conn, "thresholds")
    procedures = conn.execute(
        """
        SELECT * FROM procedures WHERE patient_id = ?
        ORDER BY planned_date, planned_time
        """,
        (patient_id,),
    ).fetchall()
    findings = conn.execute(
        """
        SELECT * FROM findings WHERE patient_id = ?
        ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 ELSE 1 END, category
        """,
        (patient_id,),
    ).fetchall()
    finding_dicts = [_row_finding(row) for row in findings]
    return {
        "patient": {
            "id": patient["id"],
            "name": patient["name"],
            "birthDate": patient["birth_date"],
            "sex": patient["sex"],
            "ward": patient["ward"],
        },
        "procedures": [
            _procedure_detail(conn, row, requirements, finding_dicts)
            for row in procedures
        ],
        "labs": _lab_rows(conn, patient_id, thresholds, finding_dicts),
        "reports": _report_rows(conn, patient_id),
        "medications": _medication_rows(conn, patient_id),
        "clearance": _clearance_dict(conn, patient_id),
    }


def create_case(conn: sqlite3.Connection, payload: dict, actor: dict) -> dict:
    requirements = get_config(conn, "requirements")
    procedure_type = payload["procedureType"]
    if procedure_type not in (requirements.get("procedures") or {}):
        return {}
    born = date.fromisoformat(payload["birthDate"])
    planned = date.fromisoformat(payload["plannedDate"])
    today = clinic_today()
    if born > today or born.year < 1900:
        return {}
    if planned < today or (planned - today).days > 60:
        return {}
    patient_id = f"pat-{uuid.uuid4().hex[:12]}"
    procedure_id = f"proc-{uuid.uuid4().hex[:12]}"
    conn.execute(
        "INSERT INTO patients (id, name, birth_date, sex, ward) VALUES (?, ?, ?, ?, ?)",
        (patient_id, payload["name"], born.isoformat(), payload["sex"], payload["ward"]),
    )
    conn.execute(
        """
        INSERT INTO procedures (
            id, patient_id, procedure_type, planned_date, planned_time,
            operator, status, readiness
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            procedure_id,
            patient_id,
            procedure_type,
            planned.isoformat(),
            payload["plannedTime"],
            payload["operator"],
            "planned",
            None,
        ),
    )
    write_audit(
        conn,
        "patient.create",
        actor,
        "patient",
        patient_id,
        {"procedureId": procedure_id, "procedureType": procedure_type},
    )
    checked = run_check(conn, procedure_id)
    return {
        "patientId": patient_id,
        "procedureId": procedure_id,
        "patientName": payload["name"],
        "plannedDate": planned.isoformat(),
        "readiness": checked.get("readiness"),
        "openIssues": checked.get("openIssues", 0),
        "tasks": list_tasks(conn, "OPEN", None, patient_id),
    }


def list_tasks(
    conn: sqlite3.Connection,
    status: str | None,
    role: str | None,
    patient_id: str | None = None,
) -> list[dict]:
    sql = """
        SELECT t.*, p.name AS patient_name, pr.procedure_type, pr.planned_date, pr.planned_time
        FROM tasks t
        JOIN patients p ON p.id = t.patient_id
        JOIN procedures pr ON pr.id = t.procedure_id
        WHERE 1 = 1
    """
    params: list[str] = []
    if status:
        sql += " AND t.status = ?"
        params.append(status)
    if role:
        sql += " AND t.assigned_role = ?"
        params.append(role)
    if patient_id:
        sql += " AND t.patient_id = ?"
        params.append(patient_id)
    sql += " ORDER BY pr.planned_date, pr.planned_time, t.assigned_role"
    rows = conn.execute(sql, params).fetchall()
    return [_task_dict(row) for row in rows]


def update_task_status(conn: sqlite3.Connection, task_id: str, status: str, actor: dict) -> dict | None:
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        return None
    conn.execute("UPDATE tasks SET status = ? WHERE id = ?", (status, task_id))
    write_audit(
        conn,
        "task.status",
        actor,
        "task",
        task_id,
        {"status": status, "procedureId": row["procedure_id"]},
    )
    _recompute_readiness(conn, row["procedure_id"])
    updated = conn.execute(
        """
        SELECT t.*, p.name AS patient_name, pr.procedure_type, pr.planned_date, pr.planned_time
        FROM tasks t
        JOIN patients p ON p.id = t.patient_id
        JOIN procedures pr ON pr.id = t.procedure_id
        WHERE t.id = ?
        """,
        (task_id,),
    ).fetchone()
    return _task_dict(updated)


def confirm_procedure(conn: sqlite3.Connection, procedure_id: str, actor: dict) -> dict | None:
    row = conn.execute("SELECT id, readiness FROM procedures WHERE id = ?", (procedure_id,)).fetchone()
    if row is None:
        return None
    stamped = _now()
    conn.execute(
        """
        UPDATE procedures
           SET confirmed_by = ?, confirmed_at = ?, confirmed_user_id = ?
         WHERE id = ?
        """,
        (actor.get("name"), stamped, actor.get("user_id"), procedure_id),
    )
    write_audit(
        conn,
        "procedure.confirm",
        actor,
        "procedure",
        procedure_id,
        {"readinessAtConfirm": row["readiness"], "confirmedAt": stamped},
    )
    return {
        "procedureId": procedure_id,
        "confirmedBy": actor.get("name"),
        "confirmedAt": stamped,
        "readiness": row["readiness"],
    }


def get_config(conn: sqlite3.Connection, key: str) -> dict:
    row = conn.execute(
        "SELECT value_json FROM app_config WHERE key = ?", (key,)
    ).fetchone()
    if row is None:
        if key == "requirements":
            return default_requirements()
        if key == "thresholds":
            return default_thresholds()
        return {}
    return json.loads(row["value_json"])


def put_config(conn: sqlite3.Connection, key: str, document: dict, actor: dict) -> dict:
    conn.execute(
        """
        INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
        """,
        (key, json.dumps(document, ensure_ascii=False), _now()),
    )
    write_audit(conn, "config.update", actor, "config", key, {"key": key})
    run_check_all(conn)
    return document


def save_extraction(
    conn: sqlite3.Connection,
    patient_id: str,
    extraction: dict,
    source_name: str,
) -> dict:
    patient = conn.execute("SELECT id FROM patients WHERE id = ?", (patient_id,)).fetchone()
    if patient is None:
        return {}
    report_type = extraction.get("reportType")
    report_date = extraction.get("date")
    document_patient_id = extraction.get("patientId")
    stored = {"patientId": patient_id, "reportType": report_type, "ids": []}

    if report_type == "LAB":
        thresholds = get_config(conn, "thresholds")
        aliases = {str(k).lower(): v for k, v in (thresholds.get("aliases") or {}).items()}
        for index, finding in enumerate(extraction.get("findings") or []):
            code = aliases.get(str(finding.get("name") or "").strip().lower())
            if not code or finding.get("value") is None or not report_date:
                continue
            obs_id = f"obs-upload-{uuid.uuid4().hex[:10]}"
            _insert_observation(
                conn,
                Observation(
                    id=obs_id,
                    patient_id=patient_id,
                    code=code,
                    value=float(finding["value"]),
                    unit=str(finding.get("unit") or ""),
                    effective_date=date.fromisoformat(report_date),
                    source=source_name,
                    document_patient_id=document_patient_id,
                ),
            )
            stored["ids"].append(obs_id)
    elif report_type == "ANESTHESIA":
        clearance_id = f"clr-upload-{patient_id}"
        conn.execute(
            "DELETE FROM anesthesia_clearances WHERE patient_id = ?", (patient_id,)
        )
        status = extraction.get("clearanceStatus") or "MISSING"
        _insert_clearance(
            conn,
            AnesthesiaClearance(
                id=clearance_id,
                patient_id=patient_id,
                status=status,
                clearance_date=date.fromisoformat(report_date) if report_date else None,
                asa_class=extraction.get("asaClass"),
                conditions=tuple(extraction.get("conditions") or []),
                anesthetist=None,
                source=source_name,
            ),
        )
        stored["ids"].append(clearance_id)
    elif report_type in {
        "ECHO",
        "CHEST_XRAY",
        "ECG",
        "AGREEMENT",
        "DUPLEX_GROIN_PRE",
        "DUPLEX_GROIN_POST",
        "GASTROSCOPY",
        "ECHO_6W",
        "ECHO_6M",
    }:
        report_id = f"rep-upload-{uuid.uuid4().hex[:10]}"
        conclusion = extraction.get("conclusionText") or ""
        evidence_bits = [
            f.get("evidence")
            for f in extraction.get("findings") or []
            if f.get("evidence")
        ]
        _insert_report(
            conn,
            DiagnosticReport(
                id=report_id,
                patient_id=patient_id,
                report_type=report_type,
                report_date=date.fromisoformat(report_date) if report_date else None,
                conclusion_text=conclusion,
                source=source_name,
                document_patient_id=document_patient_id,
                evidence="; ".join(evidence_bits)[:500] or None,
            ),
            extracted=extraction.get("findings") or [],
        )
        stored["ids"].append(report_id)

    procedures = conn.execute(
        "SELECT id FROM procedures WHERE patient_id = ?", (patient_id,)
    ).fetchall()
    stored["checks"] = [run_check(conn, row["id"]) for row in procedures]
    return stored


def list_patient_options(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT id, name FROM patients ORDER BY name"
    ).fetchall()
    return [{"id": row["id"], "name": row["name"]} for row in rows]


def write_audit(
    conn: sqlite3.Connection,
    event_type: str,
    actor: dict,
    entity_type: str,
    entity_id: str,
    detail: dict,
) -> None:
    conn.execute(
        """
        INSERT INTO audit_events (
            id, event_type, actor_id, actor_name, entity_type, entity_id,
            detail_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            uuid.uuid4().hex,
            event_type,
            actor.get("user_id"),
            actor.get("name"),
            entity_type,
            entity_id,
            json.dumps(detail, ensure_ascii=False),
            _now(),
        ),
    )


def _done_keys(conn: sqlite3.Connection, procedure_id: str) -> set[tuple[str, str, str]]:
    rows = conn.execute(
        """
        SELECT item, category, source_ref FROM tasks
         WHERE procedure_id = ? AND status = 'DONE'
        """,
        (procedure_id,),
    ).fetchall()
    return {(row["item"], row["category"], row["source_ref"]) for row in rows}


def _finding_key(finding: Finding) -> tuple[str, str, str]:
    return (finding.item, finding.category, finding.source_ref)


def _active_findings(findings: list[Finding], done: set[tuple[str, str, str]]) -> list[Finding]:
    return [finding for finding in findings if _finding_key(finding) not in done]


def _recompute_readiness(conn: sqlite3.Connection, procedure_id: str) -> str:
    rows = conn.execute(
        """
        SELECT category, severity, item, message_de, message_en, source_ref, role
          FROM findings WHERE procedure_id = ?
        """,
        (procedure_id,),
    ).fetchall()
    findings = [
        Finding(
            row["category"],
            row["severity"],
            row["item"],
            row["message_de"],
            row["message_en"],
            row["source_ref"],
            row["role"],
        )
        for row in rows
    ]
    readiness = overall_status(_active_findings(findings, _done_keys(conn, procedure_id)))
    conn.execute(
        "UPDATE procedures SET readiness = ? WHERE id = ?",
        (readiness, procedure_id),
    )
    return readiness


def _persist_findings(
    conn: sqlite3.Connection,
    procedure_id: str,
    patient_id: str,
    findings: list[Finding],
) -> str:
    done = _done_keys(conn, procedure_id)
    conn.execute("DELETE FROM findings WHERE procedure_id = ?", (procedure_id,))
    conn.execute(
        "DELETE FROM tasks WHERE procedure_id = ? AND status = 'OPEN'",
        (procedure_id,),
    )
    alive = set()
    for finding in findings:
        finding_id = uuid.uuid4().hex
        conn.execute(
            """
            INSERT INTO findings (
                id, procedure_id, patient_id, category, severity, item,
                message_de, message_en, source_ref, role
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                finding_id,
                procedure_id,
                patient_id,
                finding.category,
                finding.severity,
                finding.item,
                finding.message_de,
                finding.message_en,
                finding.source_ref,
                finding.role,
            ),
        )
        key = _finding_key(finding)
        alive.add(key)
        if key in done:
            continue
        conn.execute(
            """
            INSERT INTO tasks (
                id, procedure_id, patient_id, finding_id, item, category,
                source_ref, text_de, text_en, assigned_role, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')
            """,
            (
                uuid.uuid4().hex,
                procedure_id,
                patient_id,
                finding_id,
                finding.item,
                finding.category,
                finding.source_ref,
                finding.message_de,
                finding.message_en,
                finding.role,
            ),
        )
    for item, category, source_ref in done:
        if (item, category, source_ref) not in alive:
            conn.execute(
                """
                DELETE FROM tasks
                 WHERE procedure_id = ? AND item = ? AND category = ?
                   AND source_ref = ? AND status = 'DONE'
                """,
                (procedure_id, item, category, source_ref),
            )
    remaining_done = done & alive
    readiness = overall_status(_active_findings(findings, remaining_done))
    conn.execute(
        "UPDATE procedures SET readiness = ? WHERE id = ?",
        (readiness, procedure_id),
    )
    return readiness


def _procedure_detail(conn, row, requirements, finding_dicts) -> dict:
    own = [f for f in finding_dicts if f["procedureId"] == row["id"]]
    done = _done_keys(conn, row["id"])
    active_own = [
        f for f in own if (f["item"], f["category"], f["sourceRef"]) not in done
    ]
    rules = (requirements.get("procedures") or {}).get(row["procedure_type"]) or []
    labels = requirements.get("labels") or {}
    checklist = []
    for rule in rules:
        item = rule["item"]
        related = [f for f in active_own if f["item"] == item]
        state = item_state(
            item,
            [
                Finding(
                    f["category"],
                    f["severity"],
                    f["item"],
                    f["messageDe"],
                    f["messageEn"],
                    f["sourceRef"],
                    f["role"],
                )
                for f in related
            ],
        )
        label_de, label_en = _item_label(item, labels, conn)
        detail = related[0] if related else None
        checklist.append(
            {
                "item": item,
                "labelDe": label_de,
                "labelEn": label_en,
                "state": state,
                "required": bool(rule.get("required", True)),
                "maxAgeDays": rule.get("maxAgeDays"),
                "detailDe": detail["messageDe"] if detail else "",
                "detailEn": detail["messageEn"] if detail else "",
                "sourceRef": detail["sourceRef"] if detail else "",
            }
        )
    open_issues = conn.execute(
        "SELECT COUNT(*) AS n FROM tasks WHERE procedure_id = ? AND status = 'OPEN'",
        (row["id"],),
    ).fetchone()["n"]
    return {
        "id": row["id"],
        "procedureType": row["procedure_type"],
        "plannedDate": row["planned_date"],
        "plannedTime": row["planned_time"],
        "operator": row["operator"],
        "status": row["status"],
        "readiness": row["readiness"] or overall_status([]),
        "openIssues": open_issues,
        "confirmedBy": row["confirmed_by"],
        "confirmedAt": row["confirmed_at"],
        "checklist": checklist,
        "findings": active_own,
    }


def _item_label(item: str, labels: dict, conn) -> tuple[str, str]:
    if item.startswith("lab."):
        code = item.split(".", 1)[1]
        spec = (get_config(conn, "thresholds").get("labs") or {}).get(code) or {}
        return spec.get("labelDe") or code, spec.get("labelEn") or code
    pair = labels.get(item) or {}
    fallback = item.split(".", 1)[-1]
    return pair.get("de") or fallback, pair.get("en") or fallback


def _lab_rows(conn, patient_id, thresholds, finding_dicts) -> list[dict]:
    rows = conn.execute(
        """
        SELECT * FROM observations WHERE patient_id = ?
        ORDER BY code, effective_date DESC
        """,
        (patient_id,),
    ).fetchall()
    labs_cfg = thresholds.get("labs") or {}
    latest: dict[str, sqlite3.Row] = {}
    for row in rows:
        latest.setdefault(row["code"], row)
    result = []
    for code, row in latest.items():
        spec = labs_cfg.get(code) or {}
        related = [
            f for f in finding_dicts if f["item"] == f"lab.{code}"
        ]
        flag = "normal"
        if any(f["severity"] == "CRITICAL" for f in related):
            flag = "critical"
        elif related:
            flag = "warning"
        result.append(
            {
                "id": row["id"],
                "code": code,
                "labelDe": spec.get("labelDe") or code,
                "labelEn": spec.get("labelEn") or code,
                "value": row["value"],
                "unit": row["unit"],
                "effectiveDate": row["effective_date"],
                "expectedUnit": spec.get("unit"),
                "low": spec.get("low"),
                "high": spec.get("high"),
                "criticalLow": spec.get("criticalLow"),
                "criticalHigh": spec.get("criticalHigh"),
                "flag": flag,
                "source": row["source"],
                "documentPatientId": row["document_patient_id"],
            }
        )
    result.sort(key=lambda item: item["labelDe"])
    return result


def _report_rows(conn, patient_id) -> list[dict]:
    rows = conn.execute(
        """
        SELECT * FROM diagnostic_reports WHERE patient_id = ?
        ORDER BY report_date DESC
        """,
        (patient_id,),
    ).fetchall()
    result = []
    for row in rows:
        extracted = []
        if row["extracted_findings"]:
            extracted = json.loads(row["extracted_findings"])
        result.append(
            {
                "id": row["id"],
                "type": row["type"],
                "date": row["report_date"],
                "conclusionText": row["conclusion_text"],
                "evidence": row["evidence"],
                "sourceFile": row["source_file"],
                "documentPatientId": row["document_patient_id"],
                "extractedFindings": extracted,
            }
        )
    return result


def _medication_rows(conn, patient_id) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM medications WHERE patient_id = ? ORDER BY name",
        (patient_id,),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "name": row["name"],
            "class": row["drug_class"],
            "status": row["status"],
            "pausedSince": row["paused_since"],
            "source": row["source"],
        }
        for row in rows
    ]


def _clearance_dict(conn, patient_id) -> dict | None:
    clearance = _clearance_for(conn, patient_id)
    if clearance is None:
        return None
    return {
        "id": clearance.id,
        "status": clearance.status,
        "date": clearance.clearance_date.isoformat() if clearance.clearance_date else None,
        "asaClass": clearance.asa_class,
        "conditions": list(clearance.conditions),
        "anesthetist": clearance.anesthetist,
        "source": clearance.source,
    }


def _observations_for(conn, patient_id) -> list[Observation]:
    rows = conn.execute(
        "SELECT * FROM observations WHERE patient_id = ?", (patient_id,)
    ).fetchall()
    return [
        Observation(
            id=row["id"],
            patient_id=row["patient_id"],
            code=row["code"],
            value=row["value"],
            unit=row["unit"],
            effective_date=date.fromisoformat(row["effective_date"]),
            source=row["source"],
            document_patient_id=row["document_patient_id"],
        )
        for row in rows
    ]


def _reports_for(conn, patient_id) -> list[DiagnosticReport]:
    rows = conn.execute(
        "SELECT * FROM diagnostic_reports WHERE patient_id = ?", (patient_id,)
    ).fetchall()
    return [
        DiagnosticReport(
            id=row["id"],
            patient_id=row["patient_id"],
            report_type=row["type"],
            report_date=date.fromisoformat(row["report_date"]) if row["report_date"] else None,
            conclusion_text=row["conclusion_text"],
            source=row["source_file"],
            document_patient_id=row["document_patient_id"],
            evidence=row["evidence"],
        )
        for row in rows
    ]


def _clearance_for(conn, patient_id) -> AnesthesiaClearance | None:
    row = conn.execute(
        "SELECT * FROM anesthesia_clearances WHERE patient_id = ?",
        (patient_id,),
    ).fetchone()
    if row is None:
        return None
    return AnesthesiaClearance(
        id=row["id"],
        patient_id=row["patient_id"],
        status=row["status"],
        clearance_date=date.fromisoformat(row["clearance_date"]) if row["clearance_date"] else None,
        asa_class=row["asa_class"],
        conditions=tuple(json.loads(row["conditions_json"])),
        anesthetist=row["anesthetist"],
        source=row["source"],
    )


def _medications_for(conn, patient_id) -> list[Medication]:
    rows = conn.execute(
        "SELECT * FROM medications WHERE patient_id = ?", (patient_id,)
    ).fetchall()
    return [
        Medication(
            id=row["id"],
            patient_id=row["patient_id"],
            name=row["name"],
            drug_class=row["drug_class"],
            status=row["status"],
            paused_since=date.fromisoformat(row["paused_since"]) if row["paused_since"] else None,
            source=row["source"],
        )
        for row in rows
    ]


def _insert_observation(conn, obs: Observation) -> None:
    conn.execute(
        """
        INSERT INTO observations (
            id, patient_id, code, value, unit, effective_date, source, document_patient_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            obs.id,
            obs.patient_id,
            obs.code,
            obs.value,
            obs.unit,
            obs.effective_date.isoformat(),
            obs.source,
            obs.document_patient_id,
        ),
    )


def _insert_report(conn, report: DiagnosticReport, extracted) -> None:
    conn.execute(
        """
        INSERT INTO diagnostic_reports (
            id, patient_id, type, report_date, conclusion_text, extracted_findings,
            source_file, document_patient_id, evidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            report.id,
            report.patient_id,
            report.report_type,
            report.report_date.isoformat() if report.report_date else None,
            report.conclusion_text,
            json.dumps(extracted, ensure_ascii=False) if extracted is not None else None,
            report.source,
            report.document_patient_id,
            report.evidence,
        ),
    )


def _insert_clearance(conn, clearance: AnesthesiaClearance) -> None:
    conn.execute(
        """
        INSERT INTO anesthesia_clearances (
            id, patient_id, status, clearance_date, asa_class, conditions_json,
            anesthetist, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            clearance.id,
            clearance.patient_id,
            clearance.status,
            clearance.clearance_date.isoformat() if clearance.clearance_date else None,
            clearance.asa_class,
            json.dumps(list(clearance.conditions), ensure_ascii=False),
            clearance.anesthetist,
            clearance.source,
        ),
    )


def _insert_medication(conn, med: Medication) -> None:
    conn.execute(
        """
        INSERT INTO medications (
            id, patient_id, name, drug_class, status, paused_since, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            med.id,
            med.patient_id,
            med.name,
            med.drug_class,
            med.status,
            med.paused_since.isoformat() if med.paused_since else None,
            med.source,
        ),
    )


def _finding_dict(finding: Finding, procedure_id: str | None) -> dict:
    return {
        "procedureId": procedure_id,
        "category": finding.category,
        "severity": finding.severity,
        "item": finding.item,
        "messageDe": finding.message_de,
        "messageEn": finding.message_en,
        "sourceRef": finding.source_ref,
        "role": finding.role,
    }


def _row_finding(row) -> dict:
    return {
        "id": row["id"],
        "procedureId": row["procedure_id"],
        "category": row["category"],
        "severity": row["severity"],
        "item": row["item"],
        "messageDe": row["message_de"],
        "messageEn": row["message_en"],
        "sourceRef": row["source_ref"],
        "role": row["role"],
    }


def _task_dict(row) -> dict:
    return {
        "id": row["id"],
        "procedureId": row["procedure_id"],
        "patientId": row["patient_id"],
        "patientName": row["patient_name"],
        "procedureType": row["procedure_type"],
        "plannedDate": row["planned_date"],
        "plannedTime": row["planned_time"],
        "item": row["item"],
        "category": row["category"],
        "textDe": row["text_de"],
        "textEn": row["text_en"],
        "assignedRole": row["assigned_role"],
        "status": row["status"],
        "sourceRef": row["source_ref"],
    }


def _now() -> str:
    return datetime.now(CLINIC_TZ).isoformat(timespec="seconds")


def tomorrow(today: date | None = None) -> date:
    return (today or clinic_today()) + timedelta(days=1)
