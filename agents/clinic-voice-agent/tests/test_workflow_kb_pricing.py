from __future__ import annotations

from voiceagent.kb import KnowledgeBase
from voiceagent.pricing import UsageMeter, cost_usd
from voiceagent.workflow import default_workflow


def test_emergency_phrases_match_on_words() -> None:
    wf = default_workflow()
    hit = wf.check_guards("I have CHEST PAIN, and my arm is numb")
    assert hit is not None and hit[0].name == "emergency" and hit[1] == "chest pain"
    assert wf.check_guards("I'd like to book a check-up") is None


def test_asks_for_human_routes_to_front_desk() -> None:
    hit = default_workflow().check_guards("can I speak to a person please")
    assert hit is not None and hit[0].destination == "front_desk"


def test_knowledge_base_answers_from_the_right_section() -> None:
    kb = KnowledgeBase()
    top = kb.search("what are your hours on saturday")[0]
    assert top.heading == "Opening hours"
    assert kb.search("cancellation fee")[0].heading == "Cancellation policy"
    assert kb.search("zebra migration") == []


def test_cost_counts_only_priced_keys() -> None:
    usage = {
        "gemini-3.8-live": {"input_audio": 1_000_000, "output_audio": 100_000, "input": 5},
        "deepgram/nova-3": {"audio_seconds": 120},
        "mystery-model": {"output": 10},
    }
    total, unpriced = cost_usd(usage)
    assert total == round(3.00 + 1.20 + 2 * 0.0048, 6)
    assert unpriced == ["mystery-model"]


def test_meter_reads_session_usage() -> None:
    class U:
        def __init__(self, **kw):  # type: ignore[no-untyped-def]
            self.__dict__.update(kw)

    usage = U(model_usage=[
        U(type="llm_usage", input_tokens=100, output_tokens=20, input_text_tokens=100,
          input_audio_tokens=0, output_text_tokens=20, output_audio_tokens=0),
        U(type="tts_usage", input_tokens=0, characters_count=400, output_tokens=0,
          audio_duration=10.0),
    ])
    meter = UsageMeter()
    meter.from_session_usage(usage, {"llm": "gemini-3.8-flash", "tts": "tts", "stt": "stt"})
    assert meter.as_dict()["tts"] == {"input_text": 100.0, "output_audio": 250.0}
