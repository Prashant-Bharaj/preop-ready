"""HTTP routes. Paths have no /api prefix; the edge proxy strips it."""

from __future__ import annotations

import io
import logging
import re
from contextlib import asynccontextmanager
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, FastAPI, File, Query, Request, UploadFile
from fastapi.responses import PlainTextResponse
from pypdf import PdfReader

from app.db import connect, init_schema
from app.errors import bad_request, not_found, register_error_handlers, unprocessable
from app.extract import (
    SAMPLE_CATALOG,
    extract_document,
    extract_document_image,
    uploads_dir,
)
from app.llm_client import llm_configured
from app.repository import (
    clinic_today,
    confirm_procedure,
    get_config,
    get_patient,
    create_case,
    list_patient_options,
    list_procedures,
    list_tasks,
    mark_checklist_item_done,
    put_config,
    run_check,
    run_check_all,
    save_extraction,
    seed_if_empty,
    tomorrow,
    update_task_status,
    write_audit,
)
from app.schemas import (
    ChecklistItemDone,
    NewCase,
    RequirementsDocument,
    TaskPatch,
    ThresholdsDocument,
    UploadConfirm,
)
from app.user_identity import get_current_user

logger = logging.getLogger("app")
router = APIRouter()
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_MAX_UPLOAD = 8_000_000


def _prepare_database() -> None:
    conn = connect()
    try:
        init_schema(conn)
        seed_if_empty(conn)
        conn.commit()
    finally:
        conn.close()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _prepare_database()
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="PreOp Ready", docs_url=None, redoc_url=None, lifespan=lifespan)
    register_error_handlers(app)

    @app.middleware("http")
    async def access_log(request: Request, call_next):
        response = await call_next(request)
        logger.info("%s %s %s", request.method, request.url.path, response.status_code)
        return response

    app.include_router(router)
    return app


def _conn():
    # Schema is initialized once in lifespan — do not re-run DDL per request
    # (concurrent CREATE + reads caused intermittent patient 404s).
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@router.get("/health")
def health():
    return {"status": "ok"}


@router.get("/meta")
def meta(user: dict = Depends(get_current_user)):
    today = clinic_today()
    return {
        "today": today.isoformat(),
        "tomorrow": tomorrow(today).isoformat(),
        "horizon": (today + timedelta(days=14)).isoformat(),
        "llmConfigured": llm_configured(),
        "user": {"name": user.get("name"), "userId": user.get("user_id")},
        "disclaimer": "Demo-Werte – klinisch zu validieren",
    }


@router.get("/procedures")
def procedures(
    on_date: Optional[str] = Query(default=None, alias="date"),
    user: dict = Depends(get_current_user),
    conn=Depends(_conn),
):
    del user
    on = tomorrow() if not on_date else _parse_date(on_date)
    return {"date": on.isoformat(), "procedures": list_procedures(conn, on)}


@router.get("/patients")
def patients(user: dict = Depends(get_current_user), conn=Depends(_conn)):
    del user
    return {"patients": list_patient_options(conn)}


@router.post("/patients")
def create_patient(
    body: NewCase,
    user: dict = Depends(get_current_user),
    conn=Depends(_conn),
):
    created = create_case(conn, body.model_dump(), user)
    if not created:
        raise bad_request("The case could not be added")
    # Commit before the response so the next page load can read the new row.
    conn.commit()
    return created


@router.get("/patients/{patient_id}")
def patient(patient_id: str, user: dict = Depends(get_current_user), conn=Depends(_conn)):
    del user
    _check_id(patient_id)
    detail = get_patient(conn, patient_id)
    if detail is None:
        raise not_found("Patient was not found")
    return detail


@router.post("/check/all")
def check_all(user: dict = Depends(get_current_user), conn=Depends(_conn)):
    del user
    return {"results": run_check_all(conn)}


@router.post("/check/{procedure_id}")
def check_one(procedure_id: str, user: dict = Depends(get_current_user), conn=Depends(_conn)):
    del user
    _check_id(procedure_id)
    result = run_check(conn, procedure_id)
    if not result:
        raise not_found("Procedure was not found")
    return result


@router.get("/tasks")
def tasks(
    status: Optional[str] = None,
    role: Optional[str] = None,
    patient_id: Optional[str] = Query(default=None, alias="patientId"),
    user: dict = Depends(get_current_user),
    conn=Depends(_conn),
):
    del user
    if status and status not in {"OPEN", "DONE"}:
        raise bad_request("Status must be OPEN or DONE")
    if role and role not in {"Pflege/Koordination", "Anästhesie", "Arzt"}:
        raise bad_request("Unknown role")
    if patient_id:
        _check_id(patient_id)
    return {"tasks": list_tasks(conn, status, role, patient_id)}


@router.patch("/tasks/{task_id}")
def patch_task(
    task_id: str,
    body: TaskPatch,
    user: dict = Depends(get_current_user),
    conn=Depends(_conn),
):
    _check_id(task_id)
    updated = update_task_status(conn, task_id, body.status, user)
    if updated is None:
        raise not_found("Task was not found")
    conn.commit()
    return updated


@router.post("/procedures/{procedure_id}/checklist-done")
def checklist_item_done(
    procedure_id: str,
    body: ChecklistItemDone,
    user: dict = Depends(get_current_user),
    conn=Depends(_conn),
):
    _check_id(procedure_id)
    result = mark_checklist_item_done(conn, procedure_id, body.itemKey, user)
    if result is None:
        raise not_found("Procedure was not found")
    conn.commit()
    return result


@router.get("/config/requirements")
def read_requirements(user: dict = Depends(get_current_user), conn=Depends(_conn)):
    del user
    return get_config(conn, "requirements")


@router.put("/config/requirements")
def write_requirements(
    body: RequirementsDocument,
    user: dict = Depends(get_current_user),
    conn=Depends(_conn),
):
    document = body.model_dump()
    return put_config(conn, "requirements", document, user)


@router.get("/config/thresholds")
def read_thresholds(user: dict = Depends(get_current_user), conn=Depends(_conn)):
    del user
    return get_config(conn, "thresholds")


@router.put("/config/thresholds")
def write_thresholds(
    body: ThresholdsDocument,
    user: dict = Depends(get_current_user),
    conn=Depends(_conn),
):
    return put_config(conn, "thresholds", body.model_dump(), user)


@router.post("/procedures/{procedure_id}/confirm")
def confirm(
    procedure_id: str,
    user: dict = Depends(get_current_user),
    conn=Depends(_conn),
):
    _check_id(procedure_id)
    result = confirm_procedure(conn, procedure_id, user)
    if result is None:
        raise not_found("Procedure was not found")
    conn.commit()
    return result


_SAMPLE_FILES = {item["name"] for item in SAMPLE_CATALOG}


@router.get("/samples")
def sample_list(user: dict = Depends(get_current_user)):
    del user
    return {"samples": [dict(item) for item in SAMPLE_CATALOG]}


@router.get("/samples/{name}")
def sample_file(name: str, user: dict = Depends(get_current_user)):
    del user
    if name not in _SAMPLE_FILES or "/" in name or ".." in name:
        raise not_found("Sample was not found")
    path = uploads_dir() / name
    if not path.is_file():
        raise not_found("Sample was not found")
    return PlainTextResponse(path.read_text(encoding="utf-8"))


@router.post("/upload/extract")
async def upload_extract(
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    del user
    raw = await file.read()
    if len(raw) > _MAX_UPLOAD:
        raise bad_request("File is too large")
    if not raw:
        raise bad_request("File is empty")
    name = file.filename or "upload.txt"
    if _is_image(name, raw):
        return await extract_document_image(raw, name, file.content_type)
    text = _file_text(name, raw)
    if not text.strip():
        raise unprocessable("No text could be read from the file")
    return await extract_document(text, name)


@router.post("/upload/confirm")
def upload_confirm(
    body: UploadConfirm,
    user: dict = Depends(get_current_user),
    conn=Depends(_conn),
):
    if body.extraction.manualReviewNeeded:
        raise unprocessable("Manual review is still required")
    stored = save_extraction(
        conn,
        body.patientId,
        body.extraction.model_dump(mode="json"),
        "upload",
    )
    if not stored:
        raise not_found("Patient was not found")
    write_audit(
        conn,
        "upload.confirm",
        user,
        "patient",
        body.patientId,
        {"reportType": body.extraction.reportType},
    )
    conn.commit()
    return stored


def _check_id(value: str) -> None:
    if not _ID.fullmatch(value):
        raise bad_request("Invalid id")


def _parse_date(value: str) -> date:
    if not _DATE.fullmatch(value):
        raise bad_request("Date must be YYYY-MM-DD")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise bad_request("Date must be YYYY-MM-DD") from exc


_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff"}


def _is_image(name: str, raw: bytes) -> bool:
    lower = name.lower()
    if any(lower.endswith(ext) for ext in _IMAGE_EXTS):
        return True
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return True
    if raw[:3] == b"\xff\xd8\xff":
        return True
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return True
    if len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return True
    return False


def _file_text(name: str, raw: bytes) -> str:
    lower = name.lower()
    if lower.endswith(".pdf") or raw[:4] == b"%PDF":
        try:
            reader = PdfReader(io.BytesIO(raw))
        except Exception as exc:
            raise unprocessable("The PDF could not be read") from exc
        parts = []
        for page in reader.pages[:20]:
            parts.append(page.extract_text() or "")
        return "\n".join(parts)
    if _is_image(name, raw):
        raise unprocessable("Images must be processed as images, not text")
    return raw.decode("utf-8", errors="replace")
