"""What the alert is about. Both the planner and the analyst anchor on this, so the
investigation starts from the alerted entity instead of cluster-wide noise."""
from typing import Any

from src.ira.models.incident import Incident

# Label keys that name a concrete entity, in priority order.
ENTITY_LABELS = ("node", "host", "hostname", "instance", "pod", "container", "component")
# Log columns an entity label usually corresponds to.
_COLUMN_HINTS = {
    "node": ("Node", "Location", "Host"), "host": ("Host", "Node", "Location"),
    "hostname": ("Host", "Node", "Location"), "instance": ("Node", "Host", "Location"),
    "pod": ("Node", "Host"), "container": ("Node", "Host"), "component": ("Component",),
}


def alerted_entities(incident: Incident) -> dict[str, str]:
    entities = {k: v for k in ENTITY_LABELS if (v := incident.labels.get(k))}
    if incident.service:
        entities.setdefault("service", incident.service)
    return entities


def investigation_scope(
    incident: Incident, dataset_columns: list[str] | None = None
) -> dict[str, Any]:
    """Scope handed to the planner/analyst: alerted entities, the log dataset and which
    log columns can filter to each entity."""
    entities = alerted_entities(incident)
    scope: dict[str, Any] = {"alerted_entities": entities}
    dataset = incident.labels.get("dataset")
    if dataset:
        scope["log_dataset"] = dataset
    if dataset_columns:
        scope["filterable_columns"] = dataset_columns
        filters = {}
        for key, value in entities.items():
            column = next((c for c in _COLUMN_HINTS.get(key, ()) if c in dataset_columns), None)
            if column:
                filters[column] = value
        if filters:
            scope["suggested_filters"] = filters
    return scope
