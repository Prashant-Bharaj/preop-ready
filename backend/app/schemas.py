"""Request bodies for config edits and stored extractions."""

from __future__ import annotations

import re
from typing import Optional

from pydantic import BaseModel, Field, field_validator

from app.extract import Extraction

_ITEM = re.compile(r"^(lab|report|clearance)\.[A-Za-z0-9_-]{1,40}$")
_CODE = re.compile(r"^[a-z0-9_]{1,40}$")
_PROC = re.compile(r"^[A-Za-z0-9_-]{1,20}$")


class RequirementItem(BaseModel):
    item: str
    required: bool = True
    maxAgeDays: Optional[int] = Field(default=None, ge=0, le=3650)
    mustMention: Optional[str] = Field(default=None, max_length=40)

    @field_validator("item")
    @classmethod
    def item_shape(cls, value: str) -> str:
        if not _ITEM.fullmatch(value):
            raise ValueError("item")
        return value


class LabelPair(BaseModel):
    de: str = Field(max_length=80)
    en: str = Field(max_length=80)


class RequirementsDocument(BaseModel):
    disclaimer: str = Field(max_length=200)
    labels: dict[str, LabelPair]
    procedures: dict[str, list[RequirementItem]]

    @field_validator("procedures")
    @classmethod
    def procedure_keys(cls, value: dict) -> dict:
        for key in value:
            if not _PROC.fullmatch(key):
                raise ValueError("procedure type")
        return value


class LabThreshold(BaseModel):
    labelDe: str = Field(max_length=80)
    labelEn: str = Field(max_length=80)
    low: Optional[float] = None
    high: Optional[float] = None
    criticalLow: Optional[float] = None
    criticalHigh: Optional[float] = None
    implausibleLow: Optional[float] = None
    implausibleHigh: Optional[float] = None
    unit: str = Field(max_length=40)


class ConsistencyRules(BaseModel):
    pauseRequiredClasses: list[str] = Field(default_factory=list, max_length=8)
    metforminEgfrMin: Optional[float] = Field(default=None, ge=0, le=200)
    egfrCode: str = Field(default="egfr", max_length=40)

    @field_validator("pauseRequiredClasses")
    @classmethod
    def known_classes(cls, value: list[str]) -> list[str]:
        allowed = {"DOAC", "VKA", "ANTIPLATELET", "METFORMIN", "OTHER"}
        cleaned = []
        for item in value:
            token = item.strip().upper()
            if token not in allowed:
                raise ValueError("medication class")
            cleaned.append(token)
        return cleaned


class ThresholdsDocument(BaseModel):
    disclaimer: str = Field(max_length=200)
    labs: dict[str, LabThreshold]
    aliases: dict[str, str]
    consistency: ConsistencyRules

    @field_validator("labs")
    @classmethod
    def lab_codes(cls, value: dict) -> dict:
        for key in value:
            if not _CODE.fullmatch(key):
                raise ValueError("lab code")
        return value

    @field_validator("aliases")
    @classmethod
    def alias_targets(cls, value: dict) -> dict:
        cleaned = {}
        for key, target in value.items():
            if len(key) > 80 or not _CODE.fullmatch(str(target)):
                raise ValueError("alias")
            cleaned[str(key).lower()] = target
        return cleaned


class TaskPatch(BaseModel):
    status: str

    @field_validator("status")
    @classmethod
    def known_status(cls, value: str) -> str:
        if value not in {"OPEN", "DONE"}:
            raise ValueError("status")
        return value


class UploadConfirm(BaseModel):
    patientId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    extraction: Extraction
