from src.ira.agents.scope import alerted_entities, investigation_scope
from src.ira.tools.log_explorer.service import LogExplorerService
from tests.fakes import make_incident


def test_scope_maps_alerted_node_to_log_filter() -> None:
    inc = make_incident(labels={"dataset": "BGL", "node": "R02-M1-N0-C:J12-U11"},
                        service="bgl-compute")
    columns = LogExplorerService().columns("BGL")
    assert "Node" in columns and "Label" not in columns
    scope = investigation_scope(inc, columns)
    assert scope["alerted_entities"] == {"node": "R02-M1-N0-C:J12-U11", "service": "bgl-compute"}
    assert scope["suggested_filters"] == {"Node": "R02-M1-N0-C:J12-U11"}
    assert scope["log_dataset"] == "BGL"


def test_scope_without_entities_or_dataset() -> None:
    inc = make_incident(labels={}, service=None)
    assert alerted_entities(inc) == {}
    assert investigation_scope(inc) == {"alerted_entities": {}}
