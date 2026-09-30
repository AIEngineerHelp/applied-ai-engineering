import json

import pytest

from judgelab.config import Settings


@pytest.fixture
def settings():
    return Settings(gemini_key="test", typesafe_key="test", max_workers=2,
                    rates={"gemini": (0.3, 2.5), "jev": (None, None)})


@pytest.fixture
def workspace(tmp_path):
    """Three cases, each with a correct answer (-a) and a wrong one (-b)."""
    data, runs = tmp_path / "data", tmp_path / "runs"
    data.mkdir()
    errors = ["wrong_fact", "incomplete", "wrong_fact"]
    cases = [
        {"id": f"c{i}", "split": "holdout" if i == 3 else "dev", "kind": "direct",
         "passage": f"Passage {i}.", "question": f"Question {i}?",
         "answers": [
             {"id": f"c{i}-a", "answer": f"Right {i}.", "expected": "pass", "error": None, "source": "m"},
             {"id": f"c{i}-b", "answer": f"Wrong {i}.", "expected": "fail", "error": errors[i - 1], "source": "written"},
         ]}
        for i in (1, 2, 3)
    ]
    (data / "cases.jsonl").write_text("".join(json.dumps(c) + "\n" for c in cases))
    return {"cases": data / "cases.jsonl", "runs": runs, "root": tmp_path}
