"""Pick the conversations to label by hand, and print them blind.

The sample is stratified by cell (risk x prompt version) and by the judge's verdict: every failure, every
attack with a review note, and a fixed number of random passes from each cell. The verdict is used only to
choose the sample. The blind sheet shuffles the sample under anonymous ids and prints each conversation
with its rule, without the prompt version, the verdict or the judge's reason, so the labeller can't see
what the judge said.

    uv run python -m riskdemo.sample > sheet.md     # writes the id map next to it, in runs/
"""

import json
import random
import sys
from pathlib import Path

from riskdemo import config
from riskdemo.catalog import RISKS, VERSIONS

# Random passes to add per cell, on top of every failure and every noted attack.
EXTRA_PASSES = {
    ("investment-advice", "hardened"): 2,
    ("dispute-recourse", "naive"): 3,
    ("dispute-recourse", "hardened"): 3,
    ("medication-changes", "naive"): 1,
    ("medication-changes", "hardened"): 3,
    ("emergency-escalation", "naive"): 2,
    ("emergency-escalation", "hardened"): 2,
}
SAMPLE_SEED = 20261027


def load_set(directory: Path) -> dict[tuple[str, str], dict]:
    return {
        (r, v): json.loads((directory / f"{r}--{v}.json").read_text())
        for r in RISKS
        for v in VERSIONS
        if (directory / f"{r}--{v}.json").exists()
    }


def choose(runs: dict[tuple[str, str], dict], notes: dict, extra: dict = EXTRA_PASSES) -> list[dict]:
    """Every failed or noted attack, plus `extra` random passes per cell. Errors have no verdict to check."""
    rng = random.Random(SAMPLE_SEED)
    picked = []
    for (risk, version), run in runs.items():
        noted = {int(k) for k in notes.get(f"{risk}--{version}", {})}
        must = [a for a in run["attacks"] if a["status"] == "failed" or (a["index"] + 1 in noted and a["status"] != "error")]
        rest = [a for a in run["attacks"] if a["status"] == "passed" and a not in must]
        more = rng.sample(rest, min(extra.get((risk, version), 0), len(rest)))
        for a in sorted(must + more, key=lambda a: a["index"]):
            picked.append({"risk": risk, "version": version, "attack": a["index"] + 1})
    return picked


def blind_sheet(runs: dict[tuple[str, str], dict], sample: list[dict]) -> tuple[str, dict[str, dict]]:
    rng = random.Random(SAMPLE_SEED + 1)
    order = sample[:]
    rng.shuffle(order)
    ids = {f"L{i + 1:02d}": item for i, item in enumerate(order)}
    out = []
    for lid, item in ids.items():
        run = runs[(item["risk"], item["version"])]
        attack = run["attacks"][item["attack"] - 1]
        out.append(f"## {lid} · {RISKS[item['risk']].risk}\n\nRULE: {run['rule']}\n")
        for k, turn in enumerate(attack["turns"]):
            out.append(f"USER {k + 1}: {turn['user']}\n\nAGENT {k + 1}: {turn['agent']}\n")
        out.append("---\n")
    return "\n".join(out), ids


def main() -> None:
    runs = load_set(config.RECORDED)
    notes = json.loads((config.RECORDED / "review-notes.json").read_text())
    sample = choose(runs, notes)
    sheet, ids = blind_sheet(runs, sample)
    config.RUNS.mkdir(exist_ok=True)
    (config.RUNS / "label-ids.json").write_text(json.dumps(ids, indent=1))
    print(f"<!-- {len(sample)} conversations -->", file=sys.stderr)
    print(sheet)


if __name__ == "__main__":
    main()
