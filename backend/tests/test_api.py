"""Seeded cohort, identity gate, and offline extraction."""

import asyncio
import json
from datetime import date

from fastapi.testclient import TestClient

from app.api import create_app
from app.db import connect, init_schema
from app.extract import extract_document, mock_extract
from app.repository import list_procedures, reset_and_seed
from app.user_identity import extract_user_identity


def test_seeded_worklist_covers_every_demo_status(tmp_path):
    conn = connect(tmp_path / "demo.sqlite")
    init_schema(conn)
    reset_and_seed(conn, date(2026, 10, 10))
    conn.commit()
    rows = {row["id"]: row for row in list_procedures(conn, date(2026, 10, 11))}
    assert rows["proc-a"]["readiness"] == "GREEN"
    assert rows["proc-b"]["readiness"] == "YELLOW"
    assert rows["proc-c"]["readiness"] == "RED"
    assert rows["proc-d"]["readiness"] == "RED"
    assert rows["proc-e"]["readiness"] == "YELLOW"
    assert rows["proc-f"]["readiness"] == "RED"
    assert rows["proc-a"]["clearance"] == "GRANTED"
    assert rows["proc-b"]["clearance"] == "CONDITIONAL"
    assert rows["proc-c"]["clearance"] == "MISSING"
    detail_tasks = conn.execute(
        "SELECT text_de FROM tasks WHERE procedure_id = 'proc-c' AND item = 'report.ECHO'"
    ).fetchone()
    assert "Echokardiographie fehlt" in detail_tasks["text_de"]
    conn.close()


def test_done_task_survives_recheck(tmp_path):
    conn = connect(tmp_path / "demo.sqlite")
    init_schema(conn)
    reset_and_seed(conn, date(2026, 10, 10))
    task = conn.execute(
        "SELECT id, item, category, source_ref FROM tasks WHERE procedure_id = 'proc-e' LIMIT 1"
    ).fetchone()
    conn.execute("UPDATE tasks SET status = 'DONE' WHERE id = ?", (task["id"],))
    from app.repository import run_check

    run_check(conn, "proc-e")
    still = conn.execute(
        """
        SELECT status FROM tasks
         WHERE procedure_id = 'proc-e' AND item = ? AND category = ? AND source_ref = ?
        """,
        (task["item"], task["category"], task["source_ref"]),
    ).fetchone()
    assert still["status"] == "DONE"
    conn.close()


def test_invalid_token_never_falls_back(monkeypatch):
    monkeypatch.setenv("ALLOW_LOCAL_DEV_IDENTITY", "true")
    assert extract_user_identity({"x-amzn-oidc-data": "not-a-jwt"}) is None
    monkeypatch.delenv("ALLOW_LOCAL_DEV_IDENTITY", raising=False)
    assert extract_user_identity({}) is None
    monkeypatch.setenv("ALLOW_LOCAL_DEV_IDENTITY", "true")
    user = extract_user_identity({})
    assert user["name"] == "Dr. Test Freigabe"


def test_mock_extractor_reads_sidecar():
    text = ( __import__("pathlib").Path(__file__).resolve().parents[1] / "samples" / "echo.txt").read_text(
        encoding="utf-8"
    )
    result = mock_extract(text, "echo.txt")
    assert result["source"] == "mock"
    assert result["extraction"]["reportType"] == "ECHO"
    assert result["extraction"]["findings"][0]["evidence"] == "LVEF 58 %"
    assert result["manualReviewNeeded"] is False


def test_llm_retries_once_then_reviews():
    calls = {"n": 0}

    async def always_bad(prompt, system):
        calls["n"] += 1
        return "I cannot help"

    failed = asyncio.run(extract_document("Ein Befund ohne Kennung.", llm_call=always_bad))
    assert failed["manualReviewNeeded"] is True
    assert calls["n"] == 2

    calls["n"] = 0

    async def then_valid(prompt, system):
        calls["n"] += 1
        if calls["n"] == 1:
            return "not json"
        return json.dumps(
            {
                "reportType": "ECG",
                "date": "2026-10-09",
                "patientId": "pat-a",
                "patientName": "Testperson A",
                "findings": [],
                "clearanceStatus": None,
                "conditions": [],
                "asaClass": None,
                "conclusionText": "Sinusrhythmus.",
            }
        )

    ok = asyncio.run(extract_document("Ein EKG.", llm_call=then_valid))
    assert ok["source"] == "llm"
    assert ok["extraction"]["reportType"] == "ECG"
    assert calls["n"] == 2


def test_api_worklist_and_confirm(tmp_path, monkeypatch):
    monkeypatch.setenv("PREOP_DB_PATH", str(tmp_path / "api.sqlite"))
    monkeypatch.setenv("ALLOW_LOCAL_DEV_IDENTITY", "true")
    monkeypatch.delenv("MGA_API_KEY", raising=False)
    monkeypatch.delenv("API_KEY", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    app = create_app()
    with TestClient(app) as client:
        assert client.get("/health").json()["status"] == "ok"
        listed = client.get("/procedures")
        assert listed.status_code == 200
        assert len(listed.json()["procedures"]) == 6
        confirmed = client.post("/procedures/proc-a/confirm")
        assert confirmed.status_code == 200
        assert confirmed.json()["confirmedBy"] == "Dr. Test Freigabe"
        blocked = client.get("/procedures", headers={"x-amzn-oidc-data": "bad"})
        assert blocked.status_code == 401
