"""Stack checks instead of trusting one judge, with Giskard's own composition: `RegexMatching` for what
code can check exactly, `AllOf` and `AnyOf` to combine it with the judges.

Every stack runs on the 50 labelled conversations (40 from the first recording, 10 seeded). The judges'
verdicts are replayed from the recording through `from_fn`, so this makes no model calls; the regex runs
for real on every agent reply.

    uv run python -m riskdemo study stack     # writes results/study/stack.json
"""

import asyncio
import json
from typing import Any

from giskard.checks import AllOf, AnyOf, RegexMatching, from_fn
from giskard.checks.core.interaction.interaction import Interaction
from giskard.checks.core.interaction.trace import Trace

from riskdemo import config, measure
from riskdemo.catalog import RISKS
from riskdemo.sample import load_set

SECOND_JUDGE = "gemini-4-argon"
LABELS = {"recorded": "labels.json", "seeded": "labels-seeded.json"}
JUDGE_FILES = {"recorded": f"judge--{SECOND_JUDGE}.json", "seeded": f"judge--{SECOND_JUDGE}--seeded.json"}

# (id, name, what it means, the Giskard expression, how to build it from the parts)
STACKS: list[tuple[str, str, str, str]] = [
    ("judge", "The judge alone", "Conformity, as recorded.", "judge"),
    ("regex", "The regex alone", "Every reply must match the risk's pattern.", "AllOf([RegexMatching(turn) for turn in replies])"),
    ("judge_and_regex", "Judge AND regex", "Pass only if both pass: the regex can veto the judge.", "AllOf([judge, regex])"),
    ("judge_or_regex", "Judge OR regex", "Pass if either passes: what happens if you let a cheap check overrule the judge.", "AnyOf([judge, regex])"),
    ("two_judges", "Both judges", f"Pass only if the recorded judge and {SECOND_JUDGE} both pass.", "AllOf([judge, second_judge])"),
]


def _trace(attack: dict) -> Trace:
    return Trace[str, str](interactions=[Interaction(inputs=t["user"], outputs=t["agent"] or "") for t in attack["turns"]])


def _regex(risk_id: str, turns: int):
    _, pattern = measure.KEYWORD_CHECKS[risk_id]
    return AllOf(
        name="regex",
        checks=[RegexMatching(name=f"turn {i + 1}", pattern=pattern, target_key=f"trace.interactions[{i}].outputs") for i in range(turns)],
    )


def _replayed(name: str, passed: bool):
    return from_fn(lambda _trace: passed, name=name)


async def _verdicts(attack: dict, risk_id: str, judge: bool, second: bool) -> dict[str, bool]:
    trace = _trace(attack)
    parts = {
        "judge": lambda: _replayed("judge (recorded)", judge),
        "second": lambda: _replayed(f"{SECOND_JUDGE} (recorded)", second),
        "regex": lambda: _regex(risk_id, len(attack["turns"])),
    }
    stacks = {
        "judge": parts["judge"](),
        "regex": parts["regex"](),
        "judge_and_regex": AllOf(checks=[parts["judge"](), parts["regex"]()]),
        "judge_or_regex": AnyOf(checks=[parts["judge"](), parts["regex"]()]),
        "two_judges": AllOf(checks=[parts["judge"](), parts["second"]()]),
    }
    return {k: (await check.run(trace)).status.value == "pass" for k, check in stacks.items()}


def build() -> dict[str, Any]:
    rows = []
    for set_name, label_file in LABELS.items():
        runs = load_set(config.SETS[set_name])
        labels = json.loads((config.STUDY / label_file).read_text())["labels"]
        second = {
            (v["risk"], v["version"], v["attack"]): v["status"]
            for v in json.loads((config.STUDY / JUDGE_FILES[set_name]).read_text())["verdicts"]
        }
        for lab in labels:
            attack = runs[(lab["risk"], lab["version"])]["attacks"][lab["attack"] - 1]
            judge = next(c for c in attack["checks"] if c.get("kind") == "conformity")["status"] == "pass"
            verdicts = asyncio.run(_verdicts(attack, lab["risk"], judge, second[(lab["risk"], lab["version"], lab["attack"])] == "pass"))
            rows.append(
                {
                    "set": set_name,
                    "risk": lab["risk"],
                    "version": lab["version"],
                    "attack": lab["attack"],
                    "label": lab["label"],
                    "borderline": lab.get("borderline", False),
                    "reason": lab["reason"],
                    "verdicts": verdicts,
                }
            )
    stacks = []
    for sid, name, meaning, expr in STACKS:
        stats = measure.agreement((r["verdicts"][sid], r["label"] == "pass") for r in rows)
        stacks.append({"id": sid, "name": name, "meaning": meaning, "giskard": expr, **stats})
    return {
        "about": "Each stack re-scores the 50 labelled conversations; judge verdicts are replayed from the recording, the regex runs on every reply.",
        "patterns": {r: {"description": d, "pattern": p} for r, (d, p) in measure.KEYWORD_CHECKS.items() if r in RISKS},
        "stacks": stacks,
        "conversations": rows,
    }


def stack(_args=None) -> dict[str, Any]:
    out = build()
    (config.STUDY / "stack.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    for s in out["stacks"]:
        print(f"{s['name']:18} agree {s['agree']}/{s['n']}  false pass {s['false_pass']}  false fail {s['false_fail']}")
    return out
