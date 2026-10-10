"""Turn a free-text report into a validated extraction. Decisions stay in the rule engine."""

from __future__ import annotations

import json
import re
from datetime import date as date_cls
from datetime import timedelta
from pathlib import Path
from typing import Awaitable, Callable, Optional

from pydantic import BaseModel, Field, ValidationError, field_validator

from app.llm_client import call_llm, llm_configured

SAMPLES = Path(__file__).resolve().parent.parent / "samples"

MARKERS = {
    "SYNTH-ECHO-001": "echo.json",
    "SYNTH-XRAY-001": "xray.json",
    "SYNTH-ANEST-001": "anesthesia.json",
}

SYSTEM_PROMPT = """You extract structured data from a clinical document.
Return STRICT JSON only, with no markdown and no commentary.
Never invent values. If a value is not stated, use null.
Every non-null numeric finding needs a short verbatim evidence snippet copied from the document.
Schema:
{
  "reportType": "CHEST_XRAY" | "ECHO" | "ECG" | "LAB" | "ANESTHESIA" | "UNKNOWN",
  "date": "YYYY-MM-DD" or null,
  "patientId": string or null,
  "patientName": string or null,
  "findings": [{"name": string, "value": number or null, "unit": string or null, "evidence": string or null}],
  "clearanceStatus": "GRANTED" | "CONDITIONAL" | "MISSING" or null,
  "conditions": [string],
  "asaClass": string or null,
  "conclusionText": string or null
}
"""


class ExtractedFinding(BaseModel):
    name: str = Field(max_length=200)
    value: Optional[float] = None
    unit: Optional[str] = Field(default=None, max_length=40)
    evidence: Optional[str] = Field(default=None, max_length=500)

    @field_validator("evidence")
    @classmethod
    def evidence_when_valued(cls, evidence, info):
        value = info.data.get("value")
        if value is not None and not (evidence and evidence.strip()):
            raise ValueError("evidence required")
        return evidence


class Extraction(BaseModel):
    reportType: str
    date: Optional[date_cls] = None
    patientId: Optional[str] = Field(default=None, max_length=64)
    patientName: Optional[str] = Field(default=None, max_length=200)
    findings: list[ExtractedFinding] = Field(default_factory=list, max_length=40)
    clearanceStatus: Optional[str] = None
    conditions: list[str] = Field(default_factory=list, max_length=20)
    asaClass: Optional[str] = Field(default=None, max_length=20)
    conclusionText: Optional[str] = Field(default=None, max_length=4000)
    manualReviewNeeded: bool = False

    @field_validator("reportType")
    @classmethod
    def known_type(cls, value: str) -> str:
        allowed = {"CHEST_XRAY", "ECHO", "ECG", "LAB", "ANESTHESIA", "UNKNOWN"}
        if value not in allowed:
            raise ValueError("unknown report type")
        return value

    @field_validator("clearanceStatus")
    @classmethod
    def known_status(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        if value not in {"GRANTED", "CONDITIONAL", "MISSING"}:
            raise ValueError("unknown clearance status")
        return value

    @field_validator("patientId")
    @classmethod
    def patient_id_shape(cls, value: Optional[str]) -> Optional[str]:
        if value is None or value == "":
            return None
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value):
            raise ValueError("patient id")
        return value


def manual_review(reason: str = "manual review needed") -> dict:
    return {
        "extraction": Extraction(
            reportType="UNKNOWN",
            manualReviewNeeded=True,
            conclusionText=None,
        ).model_dump(mode="json"),
        "manualReviewNeeded": True,
        "source": "manual",
        "message": reason,
    }


def mock_extract(text: str, filename: Optional[str] = None) -> dict:
    sidecar = _sidecar_for(text, filename)
    if sidecar is None:
        return manual_review("No mock fixture matched this document")
    payload = json.loads(sidecar.read_text(encoding="utf-8"))
    if "dateOffsetDays" in payload:
        offset = int(payload.pop("dateOffsetDays"))
        payload["date"] = (date_cls.today() + timedelta(days=offset)).isoformat()
    extraction = Extraction.model_validate(payload)
    return {
        "extraction": extraction.model_dump(mode="json"),
        "manualReviewNeeded": False,
        "source": "mock",
        "message": "Offline extractor used a synthetic fixture",
    }


async def extract_document(
    text: str,
    filename: Optional[str] = None,
    llm_call: Optional[Callable[[str, str], Awaitable[str]]] = None,
) -> dict:
    cleaned = (text or "").strip()
    if not cleaned:
        return manual_review("The document had no text")
    if llm_call is None and not llm_configured():
        return mock_extract(cleaned, filename)
    caller = llm_call or call_llm
    prompt = cleaned[:15000]
    last_error = "The model response was not valid JSON"
    for attempt in range(2):
        try:
            raw = await caller(prompt if attempt == 0 else _retry_prompt(prompt, last_error), SYSTEM_PROMPT)
        except Exception:
            return manual_review("The language model could not be reached")
        try:
            extraction = _parse_model_json(raw)
        except (ValidationError, ValueError) as exc:
            last_error = exc.__class__.__name__
            continue
        dumped = extraction.model_dump(mode="json")
        return {
            "extraction": dumped,
            "manualReviewNeeded": False,
            "source": "llm",
            "message": "Extracted by the language model",
        }
    return manual_review("The language model response could not be validated")


def _retry_prompt(document: str, error: str) -> str:
    return (
        "The previous answer failed validation ("
        + error
        + "). Return only corrected JSON for this document:\n"
        + document
    )


def _parse_model_json(raw: str) -> Extraction:
    text = raw.strip()
    fence = re.search(r"\{.*\}", text, re.DOTALL)
    if not fence:
        raise ValueError("no json")
    data = json.loads(fence.group(0))
    return Extraction.model_validate(data)


def _sidecar_for(text: str, filename: Optional[str]) -> Optional[Path]:
    for marker, name in MARKERS.items():
        if marker in text:
            path = SAMPLES / name
            if path.exists():
                return path
    if filename:
        stem = Path(filename).stem.lower()
        candidate = SAMPLES / f"{stem}.json"
        if candidate.exists():
            return candidate
    return None
