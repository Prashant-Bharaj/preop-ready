"""Demo requirements and thresholds.

Every numeric cutoff the rule engine reads comes from this document
(or from a later edit stored in app_config). The engine itself has no
clinical literals.
"""

from __future__ import annotations

import copy

DISCLAIMER = "Demo-Werte – klinisch zu validieren"

_LABS = (
    "hb",
    "platelets",
    "inr",
    "aptt",
    "creatinine",
    "egfr",
    "potassium",
    "sodium",
    "tsh",
    "crp",
    "bnp",
)


def _lab_requirements(max_age_days: int) -> list[dict]:
    return [
        {"item": f"lab.{code}", "required": True, "maxAgeDays": max_age_days}
        for code in _LABS
    ]


DEFAULT_REQUIREMENTS: dict = {
    "disclaimer": DISCLAIMER,
    "labels": {
        "report.ECHO": {"de": "Echokardiographie", "en": "Echocardiography"},
        "report.CHEST_XRAY": {"de": "Röntgen-Thorax", "en": "Chest X-ray"},
        "report.ECG": {"de": "EKG", "en": "ECG"},
        "report.AGREEMENT": {
            "de": "Einverständniserklärung",
            "en": "Patient agreement",
        },
        "report.DUPLEX_GROIN_PRE": {
            "de": "Duplex Leiste (Tag vor Eingriff)",
            "en": "Groin duplex (day before)",
        },
        "report.DUPLEX_GROIN_POST": {
            "de": "Duplex Leiste (Tag nach Eingriff)",
            "en": "Groin duplex (day after)",
        },
        "report.GASTROSCOPY": {
            "de": "Gastroskopie (Tag nach Eingriff)",
            "en": "Gastroscopy (day after)",
        },
        "report.ECHO_6W": {
            "de": "Echo-Kontrolle (6 Wochen)",
            "en": "Echo follow-up (6 weeks)",
        },
        "report.ECHO_6M": {
            "de": "Echo-Kontrolle (6 Monate)",
            "en": "Echo follow-up (6 months)",
        },
        "clearance.anesthesia": {
            "de": "Anästhesiefreigabe",
            "en": "Anesthesia clearance",
        },
    },
    "procedures": {
        "TAVI": [
            *_lab_requirements(7),
            {"item": "report.ECHO", "required": True, "maxAgeDays": 90},
            {"item": "report.CHEST_XRAY", "required": True, "maxAgeDays": 30},
            {"item": "report.ECG", "required": True, "maxAgeDays": 7},
            {
                "item": "report.AGREEMENT",
                "required": True,
                "maxAgeDays": 30,
                "mustMention": "Patientenunterschrift",
            },
            {
                "item": "report.DUPLEX_GROIN_PRE",
                "required": True,
                "maxAgeDays": 1,
                "timing": "pre",
            },
            {
                "item": "report.DUPLEX_GROIN_POST",
                "required": True,
                "timing": "post",
                "offsetDays": 1,
            },
            {
                "item": "report.GASTROSCOPY",
                "required": True,
                "timing": "post",
                "offsetDays": 1,
            },
            {
                "item": "report.ECHO_6W",
                "required": True,
                "timing": "post",
                "offsetDays": 42,
            },
            {
                "item": "report.ECHO_6M",
                "required": True,
                "timing": "post",
                "offsetDays": 183,
            },
            {"item": "clearance.anesthesia", "required": True, "maxAgeDays": None},
        ],
        "M-TEER": [
            *_lab_requirements(7),
            {
                "item": "report.ECHO",
                "required": True,
                "maxAgeDays": 30,
                "mustMention": "TEE",
            },
            {"item": "report.CHEST_XRAY", "required": True, "maxAgeDays": 30},
            {"item": "report.ECG", "required": True, "maxAgeDays": 7},
            {
                "item": "report.AGREEMENT",
                "required": True,
                "maxAgeDays": 30,
                "mustMention": "Patientenunterschrift",
            },
            {
                "item": "report.DUPLEX_GROIN_PRE",
                "required": True,
                "maxAgeDays": 1,
                "timing": "pre",
            },
            {
                "item": "report.DUPLEX_GROIN_POST",
                "required": True,
                "timing": "post",
                "offsetDays": 1,
            },
            {
                "item": "report.GASTROSCOPY",
                "required": True,
                "timing": "post",
                "offsetDays": 1,
            },
            {
                "item": "report.ECHO_6W",
                "required": True,
                "timing": "post",
                "offsetDays": 42,
            },
            {
                "item": "report.ECHO_6M",
                "required": True,
                "timing": "post",
                "offsetDays": 183,
            },
            {"item": "clearance.anesthesia", "required": True, "maxAgeDays": None},
        ],
    },
}

DEFAULT_THRESHOLDS: dict = {
    "disclaimer": DISCLAIMER,
    "labs": {
        "hb": {
            "labelDe": "Hämoglobin",
            "labelEn": "Hemoglobin",
            "low": 12.0,
            "high": 17.5,
            "criticalLow": 7.0,
            "criticalHigh": 20.0,
            "implausibleLow": 2.0,
            "implausibleHigh": 25.0,
            "unit": "g/dL",
        },
        "platelets": {
            "labelDe": "Thrombozyten",
            "labelEn": "Platelets",
            "low": 150,
            "high": 400,
            "criticalLow": 50,
            "criticalHigh": 1000,
            "implausibleLow": 1,
            "implausibleHigh": 2000,
            "unit": "10^9/L",
        },
        "inr": {
            "labelDe": "INR",
            "labelEn": "INR",
            "low": 0.8,
            "high": 1.2,
            "criticalLow": None,
            "criticalHigh": 4.5,
            "implausibleLow": 0.2,
            "implausibleHigh": 15,
            "unit": "ratio",
        },
        "aptt": {
            "labelDe": "aPTT",
            "labelEn": "aPTT",
            "low": 25,
            "high": 40,
            "criticalLow": None,
            "criticalHigh": 100,
            "implausibleLow": 5,
            "implausibleHigh": 300,
            "unit": "s",
        },
        "creatinine": {
            "labelDe": "Kreatinin",
            "labelEn": "Creatinine",
            "low": 44,
            "high": 106,
            "criticalLow": None,
            "criticalHigh": 400,
            "implausibleLow": 10,
            "implausibleHigh": 2000,
            "unit": "µmol/L",
        },
        "egfr": {
            "labelDe": "eGFR",
            "labelEn": "eGFR",
            "low": 60,
            "high": 200,
            "criticalLow": 15,
            "criticalHigh": None,
            "implausibleLow": 1,
            "implausibleHigh": 250,
            "unit": "mL/min/1.73m2",
        },
        "potassium": {
            "labelDe": "Kalium",
            "labelEn": "Potassium",
            "low": 3.5,
            "high": 5.1,
            "criticalLow": 2.8,
            "criticalHigh": 6.2,
            "implausibleLow": 1.0,
            "implausibleHigh": 10.0,
            "unit": "mmol/L",
        },
        "sodium": {
            "labelDe": "Natrium",
            "labelEn": "Sodium",
            "low": 135,
            "high": 145,
            "criticalLow": 120,
            "criticalHigh": 160,
            "implausibleLow": 90,
            "implausibleHigh": 190,
            "unit": "mmol/L",
        },
        "tsh": {
            "labelDe": "TSH",
            "labelEn": "TSH",
            "low": 0.4,
            "high": 4.0,
            "criticalLow": 0.05,
            "criticalHigh": 20,
            "implausibleLow": 0.001,
            "implausibleHigh": 200,
            "unit": "mU/L",
        },
        "crp": {
            "labelDe": "CRP",
            "labelEn": "CRP",
            "low": 0,
            "high": 5,
            "criticalLow": None,
            "criticalHigh": 100,
            "implausibleLow": 0,
            "implausibleHigh": 600,
            "unit": "mg/L",
        },
        "bnp": {
            "labelDe": "BNP",
            "labelEn": "BNP",
            "low": 0,
            "high": 100,
            "criticalLow": None,
            "criticalHigh": 1000,
            "implausibleLow": 0,
            "implausibleHigh": 100000,
            "unit": "pmol/L",
        },
    },
    "aliases": {
        "hämoglobin": "hb",
        "hamoglobin": "hb",
        "hemoglobin": "hb",
        "hb": "hb",
        "thrombozyten": "platelets",
        "platelets": "platelets",
        "inr": "inr",
        "aptt": "aptt",
        "kreatinin": "creatinine",
        "creatinine": "creatinine",
        "egfr": "egfr",
        "gfr": "egfr",
        "kalium": "potassium",
        "potassium": "potassium",
        "natrium": "sodium",
        "sodium": "sodium",
        "tsh": "tsh",
        "crp": "crp",
        "bnp": "bnp",
    },
    "consistency": {
        "pauseRequiredClasses": ["DOAC", "VKA"],
        "metforminEgfrMin": 45,
        "egfrCode": "egfr",
    },
}


def default_requirements() -> dict:
    return copy.deepcopy(DEFAULT_REQUIREMENTS)


def default_thresholds() -> dict:
    return copy.deepcopy(DEFAULT_THRESHOLDS)
