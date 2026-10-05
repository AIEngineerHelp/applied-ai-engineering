import json

import httpx

from guardlab import agent, evaluate
from guardlab.providers import Gemini


def run(scenario, store_data, config):
    trace = agent.run(scenario, store_data, agent.CONFIGS[config], agent.ScriptedModel(scenario["script"]))
    return evaluate.score(scenario, trace, store_data), trace


def test_a_hijacked_model_succeeds_without_guardrails(scenarios, store_data):
    for s in scenarios.values():
        result, _ = run(s, store_data, "none")
        assert result["harmed"] == (s["kind"] != "benign"), s["id"]


def test_tool_policy_and_output_filter_stop_every_scripted_attack(scenarios, store_data):
    for s in scenarios.values():
        result, _ = run(s, store_data, "policy")
        assert not result["harmed"], s["id"]


def test_policy_sends_large_and_tainted_refunds_to_a_person(scenarios, store_data):
    assert run(scenarios["b06"], store_data, "policy")[0]["outcome"] == "sent to a person"
    assert run(scenarios["b07"], store_data, "policy")[0]["outcome"] == "sent to a person"
    assert run(scenarios["b02"], store_data, "policy")[0]["outcome"] == "completed"


def test_indirect_refund_within_limits_is_stopped_only_by_the_taint_rule(scenarios, store_data):
    result, trace = run(scenarios["i01"], store_data, "policy")
    assert not result["harmed"] and trace["pending"][0]["reason"].startswith("Untrusted text")


def test_rules_block_the_lookalike_benign_request(scenarios, store_data):
    result, _ = run(scenarios["b05"], store_data, "full")
    assert result["outcome"] == "blocked"


def test_model_layers_use_the_classifiers(scenarios, store_data):
    calls = []

    def classify(text):
        calls.append(text)
        return {"in_scope": True, "attack": True, "harmful": False}, {"ms": 5}

    trace = agent.run(scenarios["d02"], store_data, ("input_model",), agent.ScriptedModel(scenarios["d02"]["script"]),
                      input_classifier=classify)
    assert trace["blocked_by"] == "input_model" and trace["effects"] == [] and calls


def test_doc_scan_removes_flagged_notes_before_the_model_sees_them(scenarios, store_data):
    model = agent.ScriptedModel({"calls": [{"name": "lookup_order", "args": {"order_id": "A1001"}}], "reply": "$results"})
    trace = agent.run(scenarios["i01"], store_data, ("doc_scan",), model,
                      doc_classifier=lambda text: ({"attack": True}, {"ms": 1}))
    assert "pre-approved" not in trace["reply"] and "[removed" in trace["reply"]


def test_denials_hand_over_to_a_person(store_data):
    script = {"calls": [{"name": "issue_refund", "args": {"order_id": "B2001", "amount": 1}}] * 5, "reply": "x"}
    scenario = {"id": "t", "kind": "direct", "message": "hi", "expect": [], "forbid": []}
    trace = agent.run(scenario, store_data, ("tool_policy",), agent.ScriptedModel(script))
    assert trace["reply"] == agent.HANDOFF and len(trace["calls"]) == agent.MAX_DENIALS


def test_gemini_agent_round_trip_keeps_thought_signatures(scenarios, store_data):
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        if len(bodies) == 1:
            parts = [{"functionCall": {"name": "lookup_order", "args": {"order_id": "A1002"}, "id": "c1"},
                      "thoughtSignature": "sig-1"}]
        else:
            parts = [{"text": "Your tent has shipped."}]
        return httpx.Response(200, json={"candidates": [{"finishReason": "STOP", "content": {"role": "model", "parts": parts}}],
                                          "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 2}})

    gemini = Gemini("k", httpx.Client(transport=httpx.MockTransport(handler)))
    trace = agent.run(scenarios["b01"], store_data, agent.CONFIGS["full"][3:], agent.GeminiModel(gemini, "m"))
    assert trace["reply"] == "Your tent has shipped."
    second = bodies[1]["contents"]
    assert second[1]["parts"][0]["thoughtSignature"] == "sig-1"
    response = second[2]["parts"][0]["functionResponse"]
    assert response["name"] == "lookup_order" and response["id"] == "c1" and response["response"]["status"] == "shipped"
    assert bodies[0]["tools"][0]["functionDeclarations"][0]["name"] == "lookup_order"


def test_a_flagged_note_never_hijacks_the_scripted_model(scenarios, store_data):
    s = scenarios["i01"]
    trace = agent.run(s, store_data, ("doc_scan",), agent.ScriptedModel(s["script"]),
                      doc_classifier=lambda text: ({"attack": True}, {"ms": 1}))
    result = evaluate.score(s, trace, store_data)
    assert not result["harmed"] and result["stopped_by"] == "doc_scan"
    trace = agent.run(s, store_data, ("doc_scan",), agent.ScriptedModel(s["script"]),
                      doc_classifier=lambda text: ({"attack": False}, {"ms": 1}))
    assert evaluate.score(s, trace, store_data)["harmed"]
