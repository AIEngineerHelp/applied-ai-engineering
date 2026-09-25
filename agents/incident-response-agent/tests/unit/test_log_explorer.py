from src.ira.tools.log_explorer.service import LogExplorerService


def test_log_explorer_distribution():
    service = LogExplorerService()
    # Let's test Hadoop event distribution
    dist = service.get_event_distribution("Hadoop")
    assert len(dist) > 0
    # First item should be the highest count event template
    assert "EventId" in dist[0]
    assert "count" in dist[0]
    assert dist[0]["count"] >= dist[-1]["count"]

def test_log_explorer_drill_down():
    service = LogExplorerService()
    # Drill down on Hadoop event E29 (we saw this event template in Hadoop logs earlier)
    drill = service.drill_down_event("Hadoop", "E29")
    assert drill["event_id"] == "E29"
    assert "template" in drill
    assert "parameter_variances" in drill
    # The E29 template was: "Created MRAppMaster for application <*>"
    assert "Created MRAppMaster for application" in drill["template"]


def test_empty_filter_explains_itself():
    service = LogExplorerService()
    [result] = service.get_event_distribution("BGL", {"Node": "<US_DRIVER_LICENSE>"})
    assert result["no_matches"] is True
    assert "not evidence the component is down" in result["note"]
    assert result["most_common_Node_values"]  # real values to correct the filter


def test_ground_truth_label_hidden():
    df = LogExplorerService().load_logs("BGL")
    assert "Label" not in df.columns


def test_describe_tool_output():
    import json

    from src.ira.orchestrator.graph import describe_tool_output

    dist = json.dumps([{"EventId": "E1", "EventTemplate": "Failed password", "count": 383},
                       {"EventId": "E2", "EventTemplate": "Accepted", "count": 1}])
    assert describe_tool_output("log_explorer", dist) == (
        "2 event types, 384 lines; most frequent: “Failed password” ×383")
    empty = json.dumps([{"no_matches": True, "filter": {"Node": "x"}}])
    assert describe_tool_output("log_explorer", empty) == 'No log lines matched {"Node": "x"}'
    assert describe_tool_output("sandbox.run", '{"exit_code": 0}') == "Command exited with code 0"
    assert describe_tool_output("t", "plain text") == "t returned 10 characters"
