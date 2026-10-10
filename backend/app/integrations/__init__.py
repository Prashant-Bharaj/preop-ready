"""Extension points. Not implemented in this prototype.

- OrbisConnector: later HL7/FHIR pull from the hospital information system
- BookingConnector: later case creation from a scheduling system
- ResultWatcher: later automatic re-check when a new result arrives
- Notifier: later messages to the ward or anesthesia team
- DischargeHandoff: later hand-off into a discharge-letter tool
"""

from __future__ import annotations

from typing import Protocol


class OrbisConnector(Protocol):
    def pull_case(self, patient_id: str) -> None: ...


class BookingConnector(Protocol):
    def on_booking(self, external_id: str) -> None: ...


class ResultWatcher(Protocol):
    def on_new_result(self, patient_id: str) -> None: ...


class Notifier(Protocol):
    def notify(self, role: str, task_id: str) -> None: ...


class DischargeHandoff(Protocol):
    def handoff(self, procedure_id: str) -> None: ...
