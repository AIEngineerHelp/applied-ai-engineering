from pydantic import BaseModel

from evals.loghub.parsers.base import LogRecord
from src.ira.models.incident import Incident


class GroundTruth(BaseModel):
    fault_type: str
    accepted_fault_types: list[str] = []
    label: str = ""
    affected_components: list[str]
    affected_nodes: list[str]
    anomalous_templates: list[str] = []

class IncidentCase(BaseModel):
    case_id: str
    dataset: str
    incident: Incident
    log_slice: list[LogRecord]
    ground_truth: GroundTruth

class BaseBuilder:
    def build_cases(self, *args, **kwargs) -> list[IncidentCase]:
        raise NotImplementedError
